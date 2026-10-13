import type { ApiRequest } from "./Setup";

type LinkFlow = {
  linkToken: string;
  flowId: string;
  expiresAt: string;
  environment?: string;
};
type LinkHandler = { open: () => void; destroy: () => void };
type PlaidApi = {
  create: (options: {
    token: string;
    receivedRedirectUri?: string;
    onSuccess: (publicToken: string) => void;
    onExit: (
      error?: { display_message?: string; error_message?: string } | null,
    ) => void;
  }) => LinkHandler;
};
declare global {
  interface Window {
    Plaid?: PlaidApi;
  }
}
const storageKey = "connector-plaid-link";
let loading: Promise<void> | undefined;
function loadPlaid() {
  if (window.Plaid) return Promise.resolve();
  if (!loading)
    loading = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
      script.async = true;
      script.onload = () =>
        window.Plaid
          ? resolve()
          : reject(
              new Error(
                "Plaid’s bank picker could not load. Please try again.",
              ),
            );
      script.onerror = () => {
        script.remove();
        loading = undefined;
        reject(
          new Error(
            "Unable to load Plaid. Check your internet connection and try again.",
          ),
        );
      };
      document.head.appendChild(script);
    });
  return loading;
}
export function returningFromPlaid() {
  return new URLSearchParams(window.location.search).has("oauth_state_id");
}
function clearFlow() {
  sessionStorage.removeItem(storageKey);
  const url = new URL(window.location.href);
  url.searchParams.delete("oauth_state_id");
  url.searchParams.delete("plaid_oauth");
  window.history.replaceState(
    {},
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}
export async function connectPlaid(
  request: ApiRequest,
  resume = false,
): Promise<boolean> {
  const redirectUri = resume ? window.location.href : undefined;
  let flow: LinkFlow;
  if (resume) {
    try {
      flow = JSON.parse(
        sessionStorage.getItem(storageKey) || "null",
      ) as LinkFlow;
    } catch {
      throw new Error(
        "Your bank connection session was lost. Please connect again.",
      );
    }
    if (
      !flow ||
      !flow.flowId ||
      !flow.linkToken ||
      Date.parse(flow.expiresAt) <= Date.now()
    ) {
      clearFlow();
      throw new Error(
        "Your bank connection session expired. Please connect again.",
      );
    }
  } else {
    flow = await request<LinkFlow>("/api/plaid/link-token", { method: "POST" });
    sessionStorage.setItem(storageKey, JSON.stringify(flow));
  }
  await loadPlaid();
  return new Promise<boolean>((resolve, reject) => {
    const handler = window.Plaid!.create({
      token: flow.linkToken,
      ...(redirectUri ? { receivedRedirectUri: redirectUri } : {}),
      onSuccess(publicToken) {
        void request("/api/plaid/exchange", {
          method: "POST",
          body: JSON.stringify({ publicToken, flowId: flow.flowId }),
        })
          .then(() => {
            clearFlow();
            handler.destroy();
            resolve(true);
          })
          .catch((error) => {
            clearFlow();
            handler.destroy();
            reject(error);
          });
      },
      onExit(error) {
        clearFlow();
        handler.destroy();
        if (error)
          reject(
            new Error(
              error.display_message ||
                "The bank connection was not completed. Please try again.",
            ),
          );
        else resolve(false);
      },
    });
    handler.open();
  });
}
