import { createHash, randomBytes } from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore, Timestamp, type DocumentReference, type DocumentSnapshot } from "firebase-admin/firestore";
import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions";
import { defineSecret } from "firebase-functions/params";

initializeApp();
const db = getFirestore();
const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_MEMBERS = 2;
const MAX_LEDGER_BYTES = 850_000;
const KAKAO_ME = "https://kapi.kakao.com/v2/user/me";
const KAKAO_REST_KEY = defineSecret("KAKAO_REST_KEY");
const KAKAO_CLIENT_SECRET = defineSecret("KAKAO_CLIENT_SECRET");
const WEB_REDIRECT_URI = "https://jbusinessero-ctrl.github.io/doolimoa_app/";
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const requiredUid = (uid?: string) => {
  if (!uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  return uid;
};
const limited = (value: unknown, max: number) => typeof value === "string" && value.length <= max;

async function consumeAttempt(key: string, limit: number, windowMs: number): Promise<void> {
  const ref = db.collection("securityCounters").doc(hash(key));
  const now = Date.now();
  const allowed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data();
    const windowStart = data?.windowStart?.toMillis?.() ?? 0;
    const count = windowStart > now - windowMs ? Number(data?.count ?? 0) : 0;
    if (count >= limit) return false;
    tx.set(ref, { count: count + 1, windowStart: Timestamp.fromMillis(count ? windowStart : now), expiresAt: Timestamp.fromMillis(now + windowMs * 2) });
    return true;
  });
  if (!allowed) throw new HttpsError("resource-exhausted", "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.");
}

/** Exchange a Kakao access token for a Firebase custom token. Raw Kakao tokens are never stored. */
export const exchangeKakao = onRequest({ cors: ["https://jbusinessero-ctrl.github.io"], secrets: [KAKAO_REST_KEY, KAKAO_CLIENT_SECRET], maxInstances: 20 }, async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ error: "method_not_allowed" }); return; }
  try {
    await consumeAttempt(`kakao:${req.ip || "unknown"}`, 12, 60_000);
    let accessToken = req.body?.accessToken;
    if (typeof req.body?.code === "string") {
      if (req.body?.redirectUri !== WEB_REDIRECT_URI) { res.status(400).json({ error: "invalid_redirect_uri" }); return; }
      const tokenResponse = await fetch("https://kauth.kakao.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: KAKAO_REST_KEY.value(), client_secret: KAKAO_CLIENT_SECRET.value(), redirect_uri: WEB_REDIRECT_URI, code: req.body.code }),
        signal: AbortSignal.timeout(8000)
      });
      if (!tokenResponse.ok) {
        const kakaoError = await tokenResponse.json().catch(() => ({})) as { error?: string; error_code?: string };
        logger.warn("Kakao authorization code exchange rejected", { status: tokenResponse.status, error: kakaoError.error, errorCode: kakaoError.error_code });
        res.status(401).json({ error: "kakao_token_exchange_failed" }); return;
      }
      const tokenData = await tokenResponse.json() as { access_token?: string };
      accessToken = tokenData.access_token;
    }
    if (typeof accessToken !== "string" || accessToken.length < 20 || accessToken.length > 4096) {
      res.status(400).json({ error: "invalid_token" }); return;
    }
    const response = await fetch(KAKAO_ME, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) { res.status(401).json({ error: "kakao_auth_failed" }); return; }
    const kakaoUser = await response.json() as { id?: number | string; properties?: { nickname?: string } };
    if (!kakaoUser.id) { res.status(401).json({ error: "kakao_identity_missing" }); return; }
    const identityRef = db.collection("kakaoIdentityHashes").doc(hash(String(kakaoUser.id)));
    const candidateUid = `u_${randomBytes(32).toString("base64url")}`;
    const candidateUserRef = db.collection("users").doc(candidateUid);
    const candidateLedgerRef = db.collection("ledgers").doc();
    const now = Timestamp.now();
    let uid = "";
    const isNewUser = await db.runTransaction(async (tx) => {
      const identitySnap = await tx.get(identityRef);
      if (identitySnap.exists) {
        uid = identitySnap.get("uid");
        if (typeof uid !== "string" || !uid) throw new HttpsError("internal", "계정 연결 정보를 확인할 수 없습니다.");
        const userRef = db.collection("users").doc(uid);
        const userSnap = await tx.get(userRef);
        if (!userSnap.exists || userSnap.get("status") === "disabled") throw new HttpsError("permission-denied", "사용할 수 없는 계정입니다.");
        tx.update(userRef, { lastLoginAt: now });
        return false;
      }
      uid = candidateUid;
      tx.create(candidateLedgerRef, {
        ownerUid: candidateUid,
        memberUids: [candidateUid],
        status: "active",
        profile: { ledgerName: "둘이모아 가계부" },
        data: emptyLedger(),
        createdAt: now,
        updatedAt: now,
        revision: 1
      });
      tx.create(candidateUserRef, { ledgerId: candidateLedgerRef.id, nickname: limited(kakaoUser.properties?.nickname, 80) ? kakaoUser.properties?.nickname : null, createdAt: now, lastLoginAt: now, status: "active" });
      tx.create(identityRef, { uid: candidateUid, createdAt: now });
      return true;
    });
    const customToken = await getAuth().createCustomToken(uid, { isNewUser });
    res.set("Cache-Control", "no-store").status(200).json({ customToken, uid });
  } catch (error) {
    if (error instanceof HttpsError) {
      const status = error.code === "resource-exhausted" ? 429 : error.code === "unauthenticated" ? 401 : error.code === "permission-denied" ? 403 : 400;
      res.status(status).json({ error: error.code }); return;
    }
    logger.error("Kakao token exchange failed", error);
    res.status(500).json({ error: "internal" });
  }
});

function emptyLedger() {
  return { transactions: [], categoryBudgets: {}, overallBudget: 0, categories: null, paymentMethods: null, assets: { stocks: [], realEstate: [], vehicles: [], pensions: [], savings: [] } };
}

async function callerLedger(uid: string) {
  const userSnap = await db.collection("users").doc(uid).get();
  const ledgerId = userSnap.get("ledgerId");
  if (!ledgerId || typeof ledgerId !== "string") throw new HttpsError("failed-precondition", "연결된 가계부가 없습니다.");
  const ref = db.collection("ledgers").doc(ledgerId);
  const snap = await ref.get();
  const members: unknown = snap.get("memberUids");
  if (!snap.exists || snap.get("status") !== "active" || !Array.isArray(members) || !members.includes(uid)) {
    throw new HttpsError("permission-denied", "가계부 접근 권한이 없습니다.");
  }
  return { ref, snap, ledgerId, members: members as string[] };
}

function normalizeSnapshot(input: unknown) {
  if (!input || typeof input !== "object") throw new HttpsError("invalid-argument", "가계부 데이터 형식이 올바르지 않습니다.");
  const body = input as Record<string, unknown>;
  const fields = ["transactions", "categoryBudgets", "overallBudget", "categories", "paymentMethods", "ledgerName", "assets"];
  const data: Record<string, unknown> = {};
  for (const field of fields) if (field in body) data[field] = body[field];
  if (data.transactions !== undefined && (!Array.isArray(data.transactions) || data.transactions.length > 5000)) throw new HttpsError("invalid-argument", "거래 내역이 너무 많거나 올바르지 않습니다.");
  if (data.assets !== undefined && (!data.assets || typeof data.assets !== "object")) throw new HttpsError("invalid-argument", "자산 데이터 형식이 올바르지 않습니다.");
  if (data.categoryBudgets !== undefined && (!data.categoryBudgets || typeof data.categoryBudgets !== "object")) throw new HttpsError("invalid-argument", "예산 데이터 형식이 올바르지 않습니다.");
  if (data.overallBudget !== undefined && (typeof data.overallBudget !== "number" || !Number.isFinite(data.overallBudget) || data.overallBudget < 0)) throw new HttpsError("invalid-argument", "예산 금액이 올바르지 않습니다.");
  if (data.ledgerName !== undefined && (typeof data.ledgerName !== "string" || !data.ledgerName.trim() || data.ledgerName.length > 60)) throw new HttpsError("invalid-argument", "가계부 이름은 1~60자로 입력해 주세요.");
  if (Buffer.byteLength(JSON.stringify(data), "utf8") > MAX_LEDGER_BYTES) throw new HttpsError("resource-exhausted", "저장 가능한 가계부 데이터 크기를 초과했습니다.");
  return data;
}

// Turn on enforceAppCheck after the Android Play Integrity provider is configured.
export const ledgerApi = onCall({ enforceAppCheck: false, maxInstances: 50 }, async (request) => {
  const uid = requiredUid(request.auth?.uid);
  const action = request.data?.action;

  if (action === "invite.preview") {
    await consumeAttempt(`invite-preview:${uid}`, 10, 60_000);
    const token = request.data?.token;
    if (!limited(token, 512) || token.length < 32) throw new HttpsError("invalid-argument", "초대 링크가 올바르지 않습니다.");
    const inviteSnap = await db.collection("inviteTokens").doc(hash(token)).get();
    const expiresAt = inviteSnap.get("expiresAt") as Timestamp | undefined;
    if (!inviteSnap.exists || inviteSnap.get("status") !== "active" || !expiresAt || expiresAt.toMillis() <= Date.now()) throw new HttpsError("not-found", "초대 링크가 만료되었거나 이미 사용되었습니다.");
    const ledgerSnap = await db.collection("ledgers").doc(inviteSnap.get("ledgerId")).get();
    if (!ledgerSnap.exists || ledgerSnap.get("status") !== "active" || ledgerSnap.get("activeInviteHash") !== hash(token)) throw new HttpsError("not-found", "가계부를 찾을 수 없습니다.");
    if (inviteSnap.get("inviterUid") === uid) throw new HttpsError("failed-precondition", "본인이 만든 초대 링크는 수락할 수 없습니다.");
    const targetMembers = ledgerSnap.get("memberUids") as string[];
    if (targetMembers.includes(uid)) throw new HttpsError("already-exists", "이미 이 가계부의 구성원입니다.");
    if (targetMembers.length >= MAX_MEMBERS) throw new HttpsError("resource-exhausted", "가계부는 최대 2명까지 연결할 수 있습니다.");
    const currentLedgerId = (await db.collection("users").doc(uid).get()).get("ledgerId") || null;
    let currentLedgerHasData = false;
    let currentLedgerCanReplace = !currentLedgerId || currentLedgerId === inviteSnap.get("ledgerId");
    if (currentLedgerId && currentLedgerId !== inviteSnap.get("ledgerId")) {
      const currentLedger = await db.collection("ledgers").doc(currentLedgerId).get();
      currentLedgerCanReplace = !!currentLedger.exists
        && currentLedger.get("ownerUid") === uid
        && (currentLedger.get("memberUids") as string[] | undefined)?.length === 1;
      currentLedgerHasData = currentLedgerCanReplace && !isEmptyLedger(currentLedger.get("data"));
    }
    return { ledgerName: ledgerSnap.get("profile.ledgerName") || "둘이모아 가계부", currentLedgerId, currentLedgerCanReplace, currentLedgerHasData };
  }

  if (action === "invite.accept") {
    await consumeAttempt(`invite-accept:${uid}`, 5, 60_000);
    const token = request.data?.token;
    if (!limited(token, 512) || token.length < 32) throw new HttpsError("invalid-argument", "초대 링크가 올바르지 않습니다.");
    const inviteRef = db.collection("inviteTokens").doc(hash(token));
    const userRef = db.collection("users").doc(uid);
    await db.runTransaction(async (tx) => {
      const [inviteSnap, userSnap] = await Promise.all([tx.get(inviteRef), tx.get(userRef)]);
      const expiresAt = inviteSnap.get("expiresAt") as Timestamp | undefined;
      if (!inviteSnap.exists || inviteSnap.get("status") !== "active" || !expiresAt || expiresAt.toMillis() <= Date.now()) throw new HttpsError("failed-precondition", "초대 링크가 만료되었거나 이미 사용되었습니다.");
      const targetRef = db.collection("ledgers").doc(inviteSnap.get("ledgerId"));
      const targetSnap = await tx.get(targetRef);
      if (!targetSnap.exists || targetSnap.get("status") !== "active") throw new HttpsError("not-found", "가계부를 찾을 수 없습니다.");
      if (targetSnap.get("activeInviteHash") !== inviteRef.id) throw new HttpsError("failed-precondition", "초대 링크가 만료되었거나 교체되었습니다.");
      const members = targetSnap.get("memberUids") as string[];
      if (members.includes(uid)) throw new HttpsError("already-exists", "이미 이 가계부의 구성원입니다.");
      if (members.length >= MAX_MEMBERS) throw new HttpsError("resource-exhausted", "가계부는 최대 2명까지 연결할 수 있습니다.");
      if (inviteSnap.get("inviterUid") === uid) throw new HttpsError("failed-precondition", "본인이 만든 초대 링크는 수락할 수 없습니다.");
      const oldLedgerId = userSnap.get("ledgerId");
      let oldRefToDelete: DocumentReference | null = null;
      let oldInviteRef: DocumentReference | null = null;
      let oldInviteSnap: DocumentSnapshot | null = null;
      if (oldLedgerId && oldLedgerId !== targetRef.id) {
        const oldRef = db.collection("ledgers").doc(oldLedgerId);
        const oldSnap = await tx.get(oldRef);
        // Only this caller's solo ledger may be discarded after the client confirms the data-loss warning.
        if (oldSnap.exists && (oldSnap.get("ownerUid") !== uid || (oldSnap.get("memberUids") as string[])?.length !== 1)) {
          throw new HttpsError("failed-precondition", "다른 구성원이 있는 가계부는 자동으로 교체할 수 없습니다.");
        }
        if (oldSnap.exists && !isEmptyLedger(oldSnap.get("data")) && request.data?.confirmDeleteCurrentLedger !== true) {
          throw new HttpsError("failed-precondition", "현재 가계부 데이터를 삭제하려면 앱에서 삭제 확인을 완료해야 합니다.");
        }
        const oldInviteHash = oldSnap.get("activeInviteHash");
        if (typeof oldInviteHash === "string") {
          oldInviteRef = db.collection("inviteTokens").doc(oldInviteHash);
          oldInviteSnap = await tx.get(oldInviteRef);
        }
        if (oldSnap.exists) oldRefToDelete = oldRef;
      }
      const activeInviteHash = targetSnap.get("activeInviteHash");
      let previousInviteRef: DocumentReference | null = null;
      let previousInviteSnap: DocumentSnapshot | null = null;
      if (typeof activeInviteHash === "string" && activeInviteHash !== inviteRef.id) {
        previousInviteRef = db.collection("inviteTokens").doc(activeInviteHash);
        previousInviteSnap = await tx.get(previousInviteRef);
      }
      if (oldRefToDelete) tx.delete(oldRefToDelete);
      if (oldInviteRef && oldInviteSnap?.exists && oldInviteSnap.get("status") === "active") tx.update(oldInviteRef, { status: "revoked", revokedAt: FieldValue.serverTimestamp() });
      if (previousInviteRef && previousInviteSnap?.exists && previousInviteSnap.get("status") === "active") tx.update(previousInviteRef, { status: "revoked", revokedAt: FieldValue.serverTimestamp() });
      tx.update(targetRef, { memberUids: [...members, uid], activeInviteHash: FieldValue.delete(), revision: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() });
      tx.update(inviteRef, { status: "accepted", acceptedBy: uid, acceptedAt: FieldValue.serverTimestamp() });
      tx.set(userRef, { ledgerId: targetRef.id, status: "active" }, { merge: true });
    });
    return { accepted: true };
  }

  if (!["ledger.read", "ledger.write", "invite.create", "ledger.disconnect"].includes(action)) throw new HttpsError("invalid-argument", "지원하지 않는 요청입니다.");
  await consumeAttempt(`${action}:${uid}`, action === "invite.create" ? 5 : action === "ledger.write" ? 30 : 60, 60_000);
  const { ref, snap, ledgerId, members } = await callerLedger(uid);
  if (action === "ledger.read") return { ledgerId, revision: snap.get("revision") || 1, data: snap.get("data") || emptyLedger(), profile: snap.get("profile") || {} };
  if (action === "ledger.write") {
    const data = normalizeSnapshot(request.data?.data);
    const profile: Record<string, unknown> = {};
    if (typeof data.ledgerName === "string") profile.ledgerName = data.ledgerName;
    delete data.ledgerName;
    await db.runTransaction(async (tx) => {
      const current = await tx.get(ref);
      const currentMembers = current.get("memberUids") as string[];
      if (!current.exists || current.get("status") !== "active" || !currentMembers?.includes(uid)) throw new HttpsError("permission-denied", "가계부 접근 권한이 없습니다.");
      if (request.data?.expectedRevision !== current.get("revision")) throw new HttpsError("aborted", "다른 사용자가 먼저 저장했습니다. 최신 내용을 불러왔습니다.");
      tx.update(ref, { data: { ...(current.get("data") || emptyLedger()), ...data }, profile: { ...(current.get("profile") || {}), ...profile }, revision: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp(), lastWriterUid: uid });
    });
    await ref.collection("auditEvents").add({ actorUid: uid, action: "ledger.write", createdAt: FieldValue.serverTimestamp() });
    return { saved: true };
  }
  if (action === "invite.create") {
    if (members.length >= MAX_MEMBERS) throw new HttpsError("failed-precondition", "이미 2명이 연결되어 있습니다.");
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hash(token);
    const inviteRef = db.collection("inviteTokens").doc(tokenHash);
    const expiresAt = Timestamp.fromMillis(Date.now() + INVITE_TTL_MS);
    await db.runTransaction(async (tx) => {
      const current = await tx.get(ref);
      const currentMembers = current.get("memberUids") as string[];
      if (current.get("status") !== "active" || !currentMembers?.includes(uid)) throw new HttpsError("permission-denied", "가계부 접근 권한이 없습니다.");
      if (currentMembers.length >= MAX_MEMBERS) throw new HttpsError("failed-precondition", "이미 2명이 연결되어 있습니다.");
      const previousHash = current.get("activeInviteHash");
      let previousRef: DocumentReference | null = null;
      let previousSnap: DocumentSnapshot | null = null;
      if (typeof previousHash === "string") {
        previousRef = db.collection("inviteTokens").doc(previousHash);
        previousSnap = await tx.get(previousRef);
      }
      if (previousRef && previousSnap?.exists && previousSnap.get("status") === "active") tx.update(previousRef, { status: "revoked", revokedAt: FieldValue.serverTimestamp() });
      tx.create(inviteRef, { ledgerId, inviterUid: uid, status: "active", createdAt: FieldValue.serverTimestamp(), expiresAt });
      tx.update(ref, { activeInviteHash: tokenHash, updatedAt: FieldValue.serverTimestamp() });
    });
    await ref.collection("auditEvents").add({ actorUid: uid, action: "invite.create", createdAt: FieldValue.serverTimestamp() });
    return { token, expiresInSeconds: INVITE_TTL_MS / 1000 };
  }
  if (action === "ledger.disconnect") {
    if (members.length !== 2) throw new HttpsError("failed-precondition", "연결된 파트너가 없습니다.");
    const ownerUid = snap.get("ownerUid") as string;
    const removedUid = members.find((member) => member !== ownerUid)!;
    const newLedgerRef = db.collection("ledgers").doc();
    let disconnectedUid = removedUid;
    await db.runTransaction(async (tx) => {
      const current = await tx.get(ref);
      const currentMembers = current.get("memberUids") as string[];
      if (current.get("status") !== "active" || !currentMembers?.includes(uid)) throw new HttpsError("permission-denied", "가계부 접근 권한이 없습니다.");
      if (currentMembers.length !== 2) throw new HttpsError("failed-precondition", "이미 파트너 연결이 해제되었거나 상태가 변경되었습니다.");
      const transactionOwnerUid = current.get("ownerUid") as string;
      if (!transactionOwnerUid || !currentMembers.includes(transactionOwnerUid)) throw new HttpsError("failed-precondition", "가계부 소유자 정보를 확인할 수 없습니다.");
      const transactionRemovedUid = currentMembers.find((member) => member !== transactionOwnerUid)!;
      disconnectedUid = transactionRemovedUid;
      const activeHash = current.get("activeInviteHash");
      let activeInviteRef: DocumentReference | null = null;
      let activeInviteSnap: DocumentSnapshot | null = null;
      if (typeof activeHash === "string") {
        activeInviteRef = db.collection("inviteTokens").doc(activeHash);
        activeInviteSnap = await tx.get(activeInviteRef);
      }
      if (activeInviteRef && activeInviteSnap?.exists && activeInviteSnap.get("status") === "active") tx.update(activeInviteRef, { status: "revoked", revokedAt: FieldValue.serverTimestamp() });
      tx.update(ref, { memberUids: [transactionOwnerUid], activeInviteHash: FieldValue.delete(), revision: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() });
      tx.create(newLedgerRef, { ownerUid: transactionRemovedUid, memberUids: [transactionRemovedUid], status: "active", profile: { ledgerName: "둘이모아 가계부" }, data: emptyLedger(), createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), revision: 1 });
      tx.set(db.collection("users").doc(transactionRemovedUid), { ledgerId: newLedgerRef.id, status: "active" }, { merge: true });
      tx.create(ref.collection("auditEvents").doc(), { actorUid: uid, action: "ledger.disconnect", removedUid: transactionRemovedUid, createdAt: FieldValue.serverTimestamp() });
    });
    return { disconnected: true, removedUid: disconnectedUid };
  }
  throw new HttpsError("invalid-argument", "지원하지 않는 요청입니다.");
});

function isEmptyLedger(data: unknown): boolean {
  if (!data || typeof data !== "object") return true;
  const value = data as Record<string, unknown>;
  return (!Array.isArray(value.transactions) || value.transactions.length === 0)
    && Number(value.overallBudget || 0) === 0
    && Object.keys((value.categoryBudgets as object) || {}).length === 0
    && (!value.assets || Object.values(value.assets as Record<string, unknown>).every((items) => !Array.isArray(items) || items.length === 0))
    && (value.categories == null) && (value.paymentMethods == null);
}

export const pruneExpiredSecurityRecords = onSchedule("every 60 minutes", async () => {
  const now = Timestamp.now();
  for (const collectionName of ["inviteTokens", "securityCounters"]) {
    let page = await db.collection(collectionName).where("expiresAt", "<=", now).limit(400).get();
    while (!page.empty) {
      const batch = db.batch();
      page.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      page = await db.collection(collectionName).where("expiresAt", "<=", now).limit(400).get();
    }
  }
});
