export function activeAuthToken(localStore, sessionStore) {
  if (sessionStore.getItem("erp-worker-access-session") === "true") {
    return sessionStore.getItem("erp-worker-session-token") || "";
  }
  return localStore.getItem("token") || "";
}
