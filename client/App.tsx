import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type { ActionDefinition } from "../server/action-types";
import { Pipeline, Schedule } from "./Pipeline";
import {
  PasswordSetup,
  ProviderSetup,
  SetupChecklist,
  WorkspaceSetup,
  type WorkspaceSettings,
} from "./Setup";
import { connectPlaid, returningFromPlaid } from "./plaid-link";

type Category =
  | "ai"
  | "social"
  | "communications"
  | "advertising"
  | "analytics"
  | "websites"
  | "finance";
type Resource = { id: string; name: string; type: string };
type Connection = {
  provider: string;
  accountName: string;
  accountId?: string;
  resources: Resource[];
  lastVerifiedAt: string;
  status: "connected" | "error";
  error?: string;
};
export type Provider = {
  id: string;
  name: string;
  category: Category;
  description: string;
  authType: "api_key" | "oauth" | "link";
  docsUrl: string;
  callbackUrl?: string;
  configured: boolean;
  missing: string[];
  connection: Connection | null;
  credentialFields?: { name: string; label: string; secret?: boolean }[];
  actions?: ActionDefinition[];
};
type Feedback = { kind: "success" | "error"; message: string };
type Dialog =
  | { type: "api-key" | "setup" | "details" | "disconnect"; provider: Provider }
  | { type: "guide" | "public-origin" }
  | null;
type IconName =
  | "link"
  | "grid"
  | "arrow"
  | "plus"
  | "check"
  | "close"
  | "search"
  | "shield"
  | "external"
  | "logout"
  | "help"
  | "refresh"
  | "key"
  | "eye"
  | "eye-off"
  | "alert"
  | "layers"
  | "chevron"
  | "sparkles";

const categories: { id: "all" | Category; label: string }[] = [
  { id: "all", label: "All platforms" },
  { id: "ai", label: "AI" },
  { id: "social", label: "Social" },
  { id: "communications", label: "Communications" },
  { id: "advertising", label: "Advertising" },
  { id: "analytics", label: "Analytics" },
  { id: "websites", label: "Websites" },
  { id: "finance", label: "Banking" },
];

const categoryNames: Record<Category, string> = {
  ai: "AI",
  social: "Social",
  communications: "Communications",
  advertising: "Advertising",
  analytics: "Analytics",
  websites: "Websites",
  finance: "Banking",
};

function Icon({
  name,
  size = 20,
  className = "",
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  const paths: Record<IconName, ReactNode> = {
    link: (
      <>
        <path d="m10 13 4-4" />
        <path
          d="M7.6 15.4 6.2 17a3.7 3.7 0 0 1-5.2-5.2l4-4a3.7 3.7 0 0 1 5.2 0"
          transform="translate(3 -1)"
        />
        <path
          d="m14.2 8 1.4-1.5a3.7 3.7 0 0 1 5.2 5.2l-4 4a3.7 3.7 0 0 1-5.2 0"
          transform="translate(-2 -1)"
        />
      </>
    ),
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.7" />
        <rect x="14" y="3" width="7" height="7" rx="1.7" />
        <rect x="3" y="14" width="7" height="7" rx="1.7" />
        <rect x="14" y="14" width="7" height="7" rx="1.7" />
      </>
    ),
    arrow: (
      <>
        <path d="M5 12h14m-5-5 5 5-5 5" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    check: <path d="m5 12 4 4L19 6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 4.5 4.5" />
      </>
    ),
    shield: (
      <>
        <path d="m12 3 8 3v6c0 4-4.7 7.6-8 9-3.3-1.4-8-5-8-9V6l8-3Z" />
        <path d="m8 12 2.5 2.5L16 9" />
      </>
    ),
    external: (
      <>
        <path d="M13 4h7v7m0-7-10 10" />
        <path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
      </>
    ),
    logout: (
      <>
        <path d="M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4m6-4 4-4-4-4m-6 4h12" />
      </>
    ),
    help: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M9.5 8.5a2.6 2.6 0 0 1 5 1c0 2-2.5 2-2.5 4m0 3h.01" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 18 17" />
      </>
    ),
    key: (
      <>
        <circle cx="8" cy="9" r="5" />
        <path d="m12 12 8 8m-5-5 3-3m0 6 3-3" />
      </>
    ),
    eye: (
      <>
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    "eye-off": (
      <>
        <path d="m3 3 18 18M9.8 5.2A11 11 0 0 1 12 5c6.5 0 10 7 10 7a20 20 0 0 1-3.2 4M6.4 6.4A19 19 0 0 0 2 12s3.5 7 10 7a12 12 0 0 0 5.6-1.4M10 10a3 3 0 0 0 4 4" />
      </>
    ),
    alert: (
      <>
        <path d="m10.3 4.8-8 14A1.5 1.5 0 0 0 3.6 21h16.8a1.5 1.5 0 0 0 1.3-2.2l-8-14a2 2 0 0 0-3.4 0Z" />
        <path d="M12 9v5m0 3h.01" />
      </>
    ),
    layers: (
      <>
        <path d="m12 3 10 5-10 5L2 8l10-5Zm-10 9 10 5 10-5M2 16l10 5 10-5" />
      </>
    ),
    chevron: <path d="m9 5 7 7-7 7" />,
    sparkles: (
      <>
        <path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3Z" />
        <path d="m20 2 .6 1.4L22 4l-1.4.6L20 6l-.6-1.4L18 4l1.4-.6L20 2Z" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

class SessionExpiredError extends Error {}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      credentials: "same-origin",
      headers: {
        ...(options.method && options.method !== "GET"
          ? { "X-Connector-Request": "1" }
          : {}),
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
  } catch {
    throw new Error(
      "Cannot reach Connector. Check your connection and try again.",
    );
  }
  const result = (await response.json().catch(() => ({}))) as {
    error?: string;
  };
  if (response.status === 401 && path !== "/api/login")
    throw new SessionExpiredError(
      "Your session has expired. Please sign in again.",
    );
  if (!response.ok)
    throw new Error(
      result.error || `Request failed (${response.status}). Please try again.`,
    );
  return result as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}

function formatDate(value?: string): string {
  if (!value) return "Not yet verified";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not yet verified";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

function Brand({ light = false }: { light?: boolean }) {
  return (
    <div className={`brand ${light ? "brand-light" : ""}`}>
      <span className="brand-symbol">
        <Icon name="link" size={23} />
      </span>
      <span>
        connector<span className="brand-period">.</span>
      </span>
    </div>
  );
}

function Modal({
  title,
  children,
  onClose,
  footer,
  className = "",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  className?: string;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const first =
      panel.current?.querySelector<HTMLElement>("[data-autofocus]") ||
      panel.current?.querySelector<HTMLElement>("input, button, a[href]");
    first?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        panel.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]',
        ) || [],
      );
      const firstElement = focusable[0];
      const lastElement = focusable[focusable.length - 1];
      if (!firstElement) {
        event.preventDefault();
        panel.current?.focus();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === firstElement ||
          document.activeElement === panel.current)
      ) {
        event.preventDefault();
        lastElement?.focus();
      }
      if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = oldOverflow;
      previousFocus?.focus();
    };
  }, []);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`modal ${className}`}
        tabIndex={-1}
      >
        <div className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

function ProviderMark({ provider }: { provider: Provider }) {
  const id = provider.id.toLowerCase();
  const name = provider.name.toLowerCase();
  let content: ReactNode = provider.name.slice(0, 2).toUpperCase();
  let style = "neutral";
  if (id.includes("openai") || name.includes("chatgpt")) {
    style = "openai";
    content = <Icon name="sparkles" size={27} />;
  } else if (id.includes("anthropic") || name.includes("claude")) {
    style = "claude";
    content = <span className="claude-mark">✳</span>;
  } else if (id.includes("xai") || name.includes("grok")) {
    style = "grok";
    content = <span className="grok-mark">𝕏</span>;
  } else if (name.includes("slack")) {
    style = "slack";
    content = <span className="slack-mark">#</span>;
  } else if (name.includes("facebook")) {
    style = "facebook";
    content = <span className="facebook-mark">f</span>;
  } else if (name.includes("instagram")) {
    style = "instagram";
    content = (
      <svg
        viewBox="0 0 24 24"
        width="26"
        height="26"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        aria-hidden="true"
      >
        <rect x="3" y="3" width="18" height="18" rx="5" />
        <circle cx="12" cy="12" r="4" />
        <circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
      </svg>
    );
  } else if (name.includes("linkedin")) {
    style = "linkedin";
    content = <span className="linkedin-mark">in</span>;
  } else if (name.includes("google")) {
    style = "google";
    content = "G";
  } else if (name.includes("meta")) {
    style = "facebook";
    content = <span className="meta-mark">∞</span>;
  } else if (id === "whatsapp") {
    style = "whatsapp";
    content = "W";
  } else if (id === "plaid") {
    style = "plaid";
    content = <Icon name="layers" size={25} />;
  } else if (name.includes("discord")) {
    style = "discord";
    content = "D";
  } else if (name.includes("telegram")) {
    style = "telegram";
    content = (
      <svg
        viewBox="0 0 24 24"
        width="27"
        height="27"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="m21 3-3.5 18-6-5-3 3 .5-6 9-7-11 6-5-2L21 3Z" />
      </svg>
    );
  } else if (name.includes("youtube")) {
    style = "youtube";
    content = (
      <svg
        viewBox="0 0 24 24"
        width="27"
        height="27"
        fill="currentColor"
        aria-hidden="true"
      >
        <rect x="1" y="4" width="22" height="16" rx="5" />
        <path d="m10 8 6 4-6 4V8Z" fill="white" />
      </svg>
    );
  } else if (name.includes("pinterest")) {
    style = "pinterest";
    content = <span className="pinterest-mark">P</span>;
  } else if (name.includes("tiktok")) {
    style = "tiktok";
    content = <span className="tiktok-mark">♪</span>;
  } else if (name.includes("reddit")) {
    style = "reddit";
    content = (
      <svg
        viewBox="0 0 24 24"
        width="28"
        height="28"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        aria-hidden="true"
      >
        <path d="m12 8 1-5 5 1" />
        <circle cx="19" cy="4" r="1.5" />
        <ellipse cx="12" cy="14" rx="9" ry="6" />
        <path d="M5 9a2 2 0 1 0-3 3m17-3a2 2 0 1 1 3 3m-14 4c2 2 6 2 8 0" />
        <circle cx="8.5" cy="13" r="1" fill="currentColor" />
        <circle cx="15.5" cy="13" r="1" fill="currentColor" />
      </svg>
    );
  } else if (name.includes("wordpress")) {
    style = "wordpress";
    content = <span className="wordpress-mark">W</span>;
  } else if (name.includes("microsoft")) {
    style = "microsoft";
    content = (
      <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
        <path fill="#dc7359" d="M1 1h10v10H1z" />
        <path fill="#7d9b53" d="M13 1h10v10H13z" />
        <path fill="#5299b7" d="M1 13h10v10H1z" />
        <path fill="#d6ac50" d="M13 13h10v10H13z" />
      </svg>
    );
  } else if (name.includes("threads")) {
    style = "grok";
    content = <span className="threads-mark">@</span>;
  } else if (id === "x" || id.startsWith("x-")) {
    style = "grok";
    content = <span className="grok-mark">𝕏</span>;
  } else if (id === "search-console") {
    style = "google";
    content = <Icon name="search" size={25} />;
  }
  return (
    <div className={`provider-mark provider-mark-${style}`} aria-hidden="true">
      {content}
    </div>
  );
}

function Login({
  onSuccess,
  initialError,
}: {
  onSuccess: () => void;
  initialError?: string;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError || "");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      setPassword("");
      onSuccess();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="login-layout">
      <section className="login-story">
        <Brand light />
        <div className="login-story-main">
          <div className="eyebrow light-eyebrow">A LITTLE LESS COMPLICATED</div>
          <h1>
            All your connections.
            <br />
            <span>One quiet place.</span>
          </h1>
          <p>
            Keep your AI, social, advertising, analytics, and publishing
            accounts together, connected through their official APIs.
          </p>
          <div className="connection-art" aria-hidden="true">
            <span className="art-node node-one">
              <Icon name="sparkles" size={26} />
            </span>
            <span className="art-node node-two">
              <Icon name="layers" size={25} />
            </span>
            <span className="art-center">
              <Icon name="link" size={38} />
            </span>
            <span className="art-node node-three">
              <Icon name="grid" size={24} />
            </span>
            <span className="art-line line-one" />
            <span className="art-line line-two" />
            <span className="art-line line-three" />
          </div>
        </div>
        <div className="login-story-footer">
          <Icon name="shield" size={16} /> Simple connections. Your credentials
          stay private.
        </div>
      </section>
      <section className="login-form-area">
        <div className="mobile-brand">
          <Brand />
        </div>
        <form className="login-form" onSubmit={submit}>
          <div className="login-emblem">
            <Icon name="link" size={28} />
          </div>
          <div className="eyebrow">YOUR WORKSPACE</div>
          <h2>Welcome to Connector</h2>
          <p>Sign in to manage your account connections.</p>
          <label htmlFor="workspace-password">Workspace password</label>
          <input
            id="workspace-password"
            type="password"
            autoComplete="current-password"
            placeholder="Enter your workspace password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            autoFocus
            disabled={busy}
          />
          {error && (
            <div className="inline-error" role="alert">
              <Icon name="alert" size={17} />
              <span>{error}</span>
            </div>
          )}
          <button
            className="button button-primary login-submit"
            disabled={busy || !password}
            type="submit"
          >
            {busy ? (
              <>
                <Spinner /> Signing in…
              </>
            ) : (
              <>
                Open workspace <Icon name="arrow" size={18} />
              </>
            )}
          </button>
          <p className="login-password-help">
            Use the password you chose during setup. On your PC, you can also
            open Connector from the desktop launcher.
          </p>
        </form>
        <p className="login-footnote">
          <Icon name="shield" size={15} /> A private workspace for your official
          API connections.
        </p>
      </section>
    </main>
  );
}

function ApiKeyDialog({
  provider,
  onClose,
  onSubmit,
  busy,
}: {
  provider: Provider;
  onClose: () => void;
  onSubmit: (key: string, fields: Record<string, string>) => Promise<void>;
  busy: boolean;
}) {
  const [key, setKey] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState("");
  const inputId = useId();
  const close = () => {
    if (busy) return;
    setKey("");
    setFields({});
    setError("");
    onClose();
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      await onSubmit(
        key.trim(),
        Object.fromEntries(
          Object.entries(fields).map(([name, value]) => [name, value.trim()]),
        ),
      );
      setKey("");
      setFields({});
    } catch (cause) {
      let message = errorMessage(cause);
      for (const secret of [
        key,
        key.trim(),
        ...Object.values(fields),
        ...Object.values(fields).map((value) => value.trim()),
      ]) {
        if (secret) message = message.split(secret).join("[hidden]");
      }
      setError(message);
    }
  };
  return (
    <Modal title={`Connect ${provider.name}`} onClose={close}>
      <div className="dialog-provider">
        <ProviderMark provider={provider} />
        <div>
          <strong>{provider.name}</strong>
          <span>Official API connection</span>
        </div>
      </div>
      <p className="dialog-copy">
        Add {provider.category === "ai" ? "an API key" : "an access token"} from
        your {provider.name} developer account. Use the link below to open its
        developer tools, create or select a key, copy it, and paste it here.
        Connector will verify access before saving the connection.
      </p>
      {provider.id === "whatsapp" && (
        <div className="info-note">
          <p>
            This connects WhatsApp Business Cloud API with a registered business
            phone number. Personal WhatsApp accounts and WhatsApp Web QR codes
            cannot authorize this API. In Meta’s developer dashboard, open your
            app → WhatsApp → API Setup to find your access token and phone
            number ID.
          </p>
        </div>
      )}
      {provider.category === "ai" && (
        <div className="info-note">
          <p>
            To let your AI agent use your social accounts, open{" "}
            <strong>Pipeline</strong> instead. This form connects the provider’s
            developer API for direct API access.
          </p>
        </div>
      )}
      <form onSubmit={submit}>
        <label htmlFor={inputId}>
          {provider.category === "ai" ? "API key" : "Access token"}
        </label>
        <div className="password-field">
          <input
            data-autofocus
            id={inputId}
            type={visible ? "text" : "password"}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={
              provider.category === "ai"
                ? "Paste your API key"
                : "Paste your developer access token"
            }
            value={key}
            onChange={(event) => setKey(event.target.value)}
            disabled={busy}
            required
          />
          <button
            type="button"
            className="icon-button"
            onClick={() => setVisible(!visible)}
            aria-label={visible ? "Hide credential" : "Show credential"}
          >
            <Icon name={visible ? "eye-off" : "eye"} size={18} />
          </button>
        </div>
        {provider.credentialFields?.map((field) => (
          <div className="extra-credential" key={field.name}>
            <label htmlFor={`${inputId}-${field.name}`}>{field.label}</label>
            <input
              id={`${inputId}-${field.name}`}
              type={field.secret === false ? "text" : "password"}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              value={fields[field.name] || ""}
              onChange={(event) =>
                setFields((previous) => ({
                  ...previous,
                  [field.name]: event.target.value,
                }))
              }
              disabled={busy}
              required
            />
          </div>
        ))}
        <a
          className="text-link key-help"
          href={
            (
              {
                openai: "https://platform.openai.com/api-keys",
                anthropic: "https://console.anthropic.com/settings/keys",
                xai: "https://console.x.ai/",
              } as Record<string, string>
            )[provider.id] || provider.docsUrl
          }
          target="_blank"
          rel="noopener noreferrer"
        >
          {provider.category === "ai"
            ? "Get an API key"
            : "Developer access documentation"}{" "}
          <Icon name="external" size={14} />
        </a>
        <div className="info-note">
          <Icon name="help" size={18} />
          <p>
            {provider.category === "ai"
              ? "API access is separate from consumer subscriptions such as ChatGPT Plus, Claude Pro, or Grok. A developer account and API billing may be required."
              : "Use a token issued through the platform’s official developer tools. Account permissions, app approval, and API access levels determine which resources are available."}
          </p>
        </div>
        {error && (
          <div className="inline-error" role="alert">
            <Icon name="alert" size={17} />
            <span>{error}</span>
          </div>
        )}
        <div className="form-actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={close}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="button button-primary"
            disabled={
              busy ||
              !key.trim() ||
              provider.credentialFields?.some(
                (field) => !fields[field.name]?.trim(),
              )
            }
          >
            {busy ? (
              <>
                <Spinner /> Verifying…
              </>
            ) : (
              <>
                <Icon name="link" size={17} /> Connect account
              </>
            )}
          </button>
        </div>
        <p className="secret-note">
          <Icon name="shield" size={14} /> Credentials are encrypted on the
          server.
        </p>
      </form>
    </Modal>
  );
}

function Dashboard({ onLogout }: { onLogout: (message?: string) => void }) {
  const [page, setPage] = useState<
    "connections" | "pipeline" | "schedule" | "settings"
  >("connections");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [settingsError, setSettingsError] = useState("");
  const [configureOnly, setConfigureOnly] = useState(false);
  const plaidResumed = useRef(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [filter, setFilter] = useState<"all" | Category>("all");
  const [search, setSearch] = useState("");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const fail = useCallback(
    (error: unknown) => {
      if (error instanceof SessionExpiredError) {
        onLogout(error.message);
        return;
      }
      setFeedback({ kind: "error", message: errorMessage(error) });
    },
    [onLogout],
  );

  const refresh = useCallback(async () => {
    const result = await api<{ providers: Provider[] }>("/api/providers");
    setProviders(result.providers);
    setLoadError("");
    return result.providers;
  }, []);

  const refreshSettings = useCallback(async () => {
    const result = await api<WorkspaceSettings>("/api/settings");
    setSettings(result);
    setSettingsError("");
  }, []);
  useEffect(() => {
    void refreshSettings().catch((cause) =>
      setSettingsError(errorMessage(cause)),
    );
  }, [refreshSettings]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      await refresh();
    } catch (error) {
      if (error instanceof SessionExpiredError) onLogout(error.message);
      else setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [refresh, onLogout]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("connected"))
      setFeedback({
        kind: "success",
        message: "Account connected. Your connection is ready.",
      });
    if (params.has("error"))
      setFeedback({
        kind: "error",
        message:
          params.get("error") ||
          "The connection could not be completed. Please try again.",
      });
    if (params.has("connected") || params.has("error")) {
      params.delete("connected");
      params.delete("error");
      const query = params.toString();
      window.history.replaceState(
        {},
        "",
        `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
      );
    }
  }, []);

  const connect = async (provider: Provider) => {
    if (!provider.configured) {
      setConfigureOnly(false);
      setDialog({ type: "setup", provider });
      return;
    }
    if (provider.authType === "api_key") {
      setDialog({ type: "api-key", provider });
      return;
    }
    if (
      settings?.origin.startsWith("https://") &&
      window.location.origin !== settings.origin
    ) {
      setDialog({ type: "public-origin" });
      return;
    }
    setBusy(provider.id);
    setFeedback(null);
    try {
      if (provider.authType === "link") {
        const linked = await connectPlaid(api);
        if (linked) {
          await refresh();
          setFeedback({
            kind: "success",
            message:
              "Bank connected. Your available accounts are ready to view.",
          });
        }
        setBusy(null);
        return;
      }
      const result = await api<{ url: string }>(
        `/api/oauth/${encodeURIComponent(provider.id)}/start`,
        { method: "POST" },
      );
      const destination = new URL(result.url);
      if (destination.protocol !== "https:")
        throw new Error(
          "The provider returned an invalid authorization URL. Check your setup.",
        );
      window.location.assign(destination.href);
    } catch (error) {
      if (provider.authType === "link") {
        try {
          await refresh();
        } catch {
          /* Preserve the bank connection error. */
        }
      }
      fail(error);
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!returningFromPlaid() || plaidResumed.current) return;
    plaidResumed.current = true;
    setBusy("plaid");
    void connectPlaid(api, true)
      .then(async (linked) => {
        if (linked) {
          await refresh();
          setFeedback({
            kind: "success",
            message:
              "Bank connected. Your available accounts are ready to view.",
          });
        }
      })
      .catch(async (error) => {
        try {
          await refresh();
        } catch {
          /* Preserve the bank connection error. */
        }
        fail(error);
      })
      .finally(() => setBusy(null));
  }, [refresh, fail]);

  const connectKey = async (
    provider: Provider,
    apiKey: string,
    fields: Record<string, string>,
  ) => {
    setBusy(provider.id);
    setFeedback(null);
    try {
      await api(`/api/connections/${encodeURIComponent(provider.id)}/api-key`, {
        method: "POST",
        body: JSON.stringify({ apiKey, fields }),
      });
      await refresh();
      setDialog(null);
      setFeedback({
        kind: "success",
        message: `${provider.name} is connected and verified.`,
      });
    } catch (error) {
      if (error instanceof SessionExpiredError) onLogout(error.message);
      else throw error;
    } finally {
      setBusy(null);
    }
  };

  const verify = async (provider: Provider) => {
    setBusy(provider.id);
    setFeedback(null);
    try {
      await api(`/api/connections/${encodeURIComponent(provider.id)}/verify`, {
        method: "POST",
      });
      await refresh();
      setFeedback({
        kind: "success",
        message: `${provider.name} connection verified.`,
      });
    } catch (error) {
      fail(error);
      try {
        await refresh();
      } catch {
        /* Keep the original verification error visible. */
      }
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (provider: Provider) => {
    setBusy(provider.id);
    setFeedback(null);
    try {
      await api(`/api/connections/${encodeURIComponent(provider.id)}`, {
        method: "DELETE",
      });
      await refresh();
      setDialog(null);
      setFeedback({
        kind: "success",
        message: `${provider.name} disconnected. Saved credentials have been removed.`,
      });
    } catch (error) {
      fail(error);
      setDialog(null);
    } finally {
      setBusy(null);
    }
  };

  const logout = async () => {
    setBusy("logout");
    try {
      await api("/api/logout", { method: "POST" });
      onLogout();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
    }
  };

  const connected = providers.filter(
    (provider) => provider.connection?.status === "connected",
  ).length;
  const attention = providers.filter(
    (provider) => provider.connection?.status === "error",
  ).length;
  const categoryCount = new Set(providers.map((provider) => provider.category))
    .size;
  const availableCategories = categories.filter(
    (category) =>
      category.id === "all" ||
      providers.some((provider) => provider.category === category.id),
  );
  const shown = providers.filter(
    (provider) =>
      (filter === "all" || provider.category === filter) &&
      `${provider.name} ${provider.description} ${categoryNames[provider.category]}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  const dialogProvider =
    dialog && "provider" in dialog
      ? providers.find((provider) => provider.id === dialog.provider.id) ||
        dialog.provider
      : null;

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <Brand light />
        <div className="workspace-selector">
          <span className="workspace-avatar">W</span>
          <span>
            <strong>My workspace</strong>
            <small>Personal connector</small>
          </span>
          <span className="workspace-dot" title="Signed in" />
        </div>
        <div className="sidebar-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          <button
            className={`nav-item ${page === "connections" ? "active" : ""}`}
            onClick={() => setPage("connections")}
            aria-current={page === "connections" ? "page" : undefined}
            aria-label="Connections"
          >
            <Icon name="grid" size={19} />
            <span>Connections</span>
            <span className="nav-count">{connected}</span>
          </button>
          <button
            className={`nav-item ${page === "pipeline" ? "active" : ""}`}
            onClick={() => setPage("pipeline")}
            aria-current={page === "pipeline" ? "page" : undefined}
            aria-label="Pipeline"
          >
            <Icon name="link" size={19} />
            <span>Pipeline</span>
          </button>
          <button
            className={`nav-item ${page === "schedule" ? "active" : ""}`}
            onClick={() => setPage("schedule")}
            aria-current={page === "schedule" ? "page" : undefined}
            aria-label="Schedule"
          >
            <Icon name="layers" size={19} />
            <span>Schedule</span>
          </button>
          <button
            className={`nav-item ${page === "settings" ? "active" : ""}`}
            aria-current={page === "settings" ? "page" : undefined}
            aria-label="Settings"
            onClick={() => setPage("settings")}
          >
            <Icon name="key" size={19} />
            <span>Settings</span>
          </button>
          <button
            className="nav-item"
            onClick={() => setDialog({ type: "guide" })}
          >
            <Icon name="help" size={19} />
            <span>Setup guide</span>
            <Icon name="chevron" size={14} />
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <span className="sidebar-note-icon">
              <Icon name="shield" size={20} />
            </span>
            <strong>Connected with care</strong>
            <p>Your credentials are encrypted and kept on your server.</p>
            <button onClick={() => setDialog({ type: "guide" })}>
              How connections work <Icon name="arrow" size={14} />
            </button>
          </div>
          <button
            className="sign-out"
            onClick={() => void logout()}
            disabled={busy === "logout"}
          >
            {busy === "logout" ? <Spinner /> : <Icon name="logout" size={17} />}{" "}
            Sign out
          </button>
          <div className="sidebar-version">
            <span>Connector</span>
            <span>Keep it simple.</span>
          </div>
        </div>
      </aside>

      <div className="main-column">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>Workspace</span>
            <Icon name="chevron" size={12} />
            <strong>
              {page === "connections"
                ? "Connections"
                : page === "pipeline"
                  ? "Pipeline"
                  : page === "settings"
                    ? "Settings"
                    : "Schedule"}
            </strong>
          </div>
          <div className="topbar-right">
            <span className="private-workspace">
              <Icon name="shield" size={15} /> Private workspace
            </span>
            <span className="user-avatar" aria-label="Your workspace">
              W
            </span>
          </div>
        </header>
        <main id={page} className="main-content">
          {!settings && !settingsError ? (
            <section className="settings-loading">
              <p role="status">Loading your workspace settings…</p>
            </section>
          ) : settings && !settings.passwordConfigured ? (
            <PasswordSetup
              initial
              request={api}
              onSaved={() => {
                void refreshSettings().catch(fail);
              }}
            />
          ) : page === "settings" ? (
            settings ? (
              <WorkspaceSetup
                settings={settings}
                providers={providers}
                request={api}
                onRefresh={refreshSettings}
                onConfigure={(provider) => {
                  setConfigureOnly(true);
                  setDialog({ type: "setup", provider });
                }}
                onPasswordSaved={() => {
                  setFeedback({
                    kind: "success",
                    message: "Your workspace password has been updated.",
                  });
                  void refreshSettings().catch(fail);
                }}
              />
            ) : (
              <section className="settings-loading">
                <p role={settingsError ? "alert" : "status"}>
                  {settingsError || "Loading workspace settings…"}
                </p>
                {settingsError && (
                  <button
                    className="button button-primary"
                    onClick={() => void refreshSettings().catch(fail)}
                  >
                    Try again
                  </button>
                )}
              </section>
            )
          ) : page === "connections" ? (
            <>
              <section className="page-heading">
                <div>
                  <div className="eyebrow">LESS FRICTION. MORE CONNECTION.</div>
                  <h1>
                    Your accounts, connected<span>.</span>
                  </h1>
                  <p>A simple home for the platforms you work with.</p>
                </div>
                <div className="official-badge">
                  <span />
                  <span>Official APIs only</span>
                </div>
              </section>

              {feedback && (
                <div
                  className={`feedback feedback-${feedback.kind}`}
                  role={feedback.kind === "error" ? "alert" : "status"}
                >
                  <Icon
                    name={feedback.kind === "error" ? "alert" : "check"}
                    size={18}
                  />
                  <span>{feedback.message}</span>
                  <button
                    className="icon-button"
                    onClick={() => setFeedback(null)}
                    aria-label="Dismiss notification"
                  >
                    <Icon name="close" size={17} />
                  </button>
                </div>
              )}

              <SetupChecklist
                settings={settings}
                connected={connected}
                onSettings={() => setPage("settings")}
                onAgents={() => setPage("pipeline")}
              />
              {settings?.origin.startsWith("https://") &&
                settings.origin !== window.location.origin && (
                  <div className="public-origin-note">
                    <p>
                      Connect accounts from your public workspace so platform
                      sign-in returns to the right address. Sign in there with
                      the password you chose.
                    </p>
                    <a
                      className="button button-secondary"
                      href={settings.origin}
                    >
                      Open public workspace ↗
                    </a>
                  </div>
                )}
              <section className="stats-grid" aria-label="Connection summary">
                <div className="stat-card">
                  <div>
                    <span className="stat-label">Connected accounts</span>
                    <div className="stat-number">
                      {loading ? "—" : connected}
                      <span className="stat-indicator">
                        <span />
                        {connected ? "Ready to use" : "Let’s get started"}
                      </span>
                    </div>
                  </div>
                  <span className="stat-icon stat-icon-teal">
                    <Icon name="link" size={22} />
                  </span>
                </div>
                <div className="stat-card">
                  <div>
                    <span className="stat-label">Available integrations</span>
                    <div className="stat-number">
                      {loading ? "—" : providers.length}
                      <span className="stat-caption">One place to connect</span>
                    </div>
                  </div>
                  <span className="stat-icon">
                    <Icon name="grid" size={21} />
                  </span>
                </div>
                <div className="stat-card">
                  <div>
                    <span className="stat-label">Platform categories</span>
                    <div className="stat-number">
                      {loading ? "—" : categoryCount}
                      <span className="stat-caption">Across your workflow</span>
                    </div>
                  </div>
                  <span className="stat-icon">
                    <Icon name="layers" size={22} />
                  </span>
                </div>
              </section>

              <section
                className="platform-section"
                aria-labelledby="platforms-title"
              >
                <div className="section-heading">
                  <div>
                    <h2 id="platforms-title">
                      Your connections{" "}
                      <span>{loading ? "—" : providers.length}</span>
                    </h2>
                    <p>Choose a platform to securely connect your account.</p>
                  </div>
                  <button
                    className="text-button refresh-list"
                    onClick={() => void load()}
                    disabled={loading || !!busy}
                  >
                    <Icon
                      name="refresh"
                      size={16}
                      className={loading ? "spin" : ""}
                    />
                    <span>Refresh</span>
                  </button>
                </div>
                <div className="filter-bar">
                  <div
                    className="category-tabs"
                    role="group"
                    aria-label="Filter by platform category"
                  >
                    {availableCategories.map((category) => (
                      <button
                        key={category.id}
                        className={`category-tab ${filter === category.id ? "selected" : ""}`}
                        aria-pressed={filter === category.id}
                        onClick={() => setFilter(category.id)}
                      >
                        {category.label}
                        {category.id === "all" && (
                          <span>{providers.length}</span>
                        )}
                      </button>
                    ))}
                  </div>
                  <div className="search-field">
                    <Icon name="search" size={17} />
                    <input
                      aria-label="Search platforms"
                      placeholder="Search platforms…"
                      type="search"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                  </div>
                </div>

                {attention > 0 && (
                  <div className="attention-note">
                    <Icon name="alert" size={16} />
                    <span>
                      {attention}{" "}
                      {attention === 1
                        ? "connection needs"
                        : "connections need"}{" "}
                      attention. Verify or reconnect to restore access.
                    </span>
                  </div>
                )}

                {loading ? (
                  <div
                    className="provider-grid"
                    aria-busy="true"
                    aria-label="Loading platforms"
                  >
                    {[0, 1, 2, 3, 4, 5].map((index) => (
                      <div key={index} className="provider-skeleton">
                        <div className="skeleton skeleton-logo" />
                        <div className="skeleton skeleton-title" />
                        <div className="skeleton skeleton-line" />
                        <div className="skeleton skeleton-line short" />
                        <div className="skeleton skeleton-button" />
                      </div>
                    ))}
                  </div>
                ) : loadError ? (
                  <div className="empty-state">
                    <span className="empty-icon">
                      <Icon name="alert" size={27} />
                    </span>
                    <h3>We couldn’t load your connections</h3>
                    <p>{loadError}</p>
                    <button
                      className="button button-primary"
                      onClick={() => void load()}
                    >
                      <Icon name="refresh" size={17} /> Try again
                    </button>
                  </div>
                ) : shown.length === 0 ? (
                  <div className="empty-state">
                    <span className="empty-icon">
                      <Icon name="search" size={27} />
                    </span>
                    <h3>
                      {providers.length
                        ? "No platforms found"
                        : "No integrations available yet"}
                    </h3>
                    <p>
                      {providers.length
                        ? "Try another search or choose a different category."
                        : "Configured integrations will appear here when they are available."}
                    </p>
                    {providers.length > 0 && (
                      <button
                        className="button button-secondary"
                        onClick={() => {
                          setSearch("");
                          setFilter("all");
                        }}
                      >
                        Clear filters
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="provider-grid">
                    {shown.map((provider) => {
                      const connection = provider.connection;
                      const status =
                        connection?.status === "connected"
                          ? "connected"
                          : connection?.status === "error"
                            ? "attention"
                            : !provider.configured
                              ? "setup"
                              : "disconnected";
                      const statusLabel = {
                        connected: "Connected",
                        attention: "Needs attention",
                        setup: "Setup required",
                        disconnected: "Not connected",
                      }[status];
                      const isBusy = busy === provider.id;
                      return (
                        <article
                          className={`provider-card ${connection?.status === "connected" ? "is-connected" : ""}`}
                          key={provider.id}
                        >
                          <div className="provider-card-top">
                            <ProviderMark provider={provider} />
                            <span className="category-badge">
                              {categoryNames[provider.category]}
                            </span>
                          </div>
                          <h3>{provider.name}</h3>
                          <p className="provider-description">
                            {provider.description}
                          </p>
                          <div className="provider-state-row">
                            <span
                              className={`connection-status status-${status}`}
                            >
                              <span className="status-dot" />
                              {statusLabel}
                            </span>
                            <span className="auth-label">
                              {provider.authType === "link"
                                ? "Secure bank sign-in"
                                : provider.authType === "oauth"
                                  ? "Official sign-in"
                                  : provider.category === "ai"
                                    ? "API key"
                                    : "Access token"}
                            </span>
                          </div>
                          {connection && (
                            <div className="connected-account">
                              <Icon
                                name={
                                  status === "attention" ? "alert" : "check"
                                }
                                size={14}
                              />
                              <span title={connection.accountName}>
                                {connection.accountName}
                              </span>
                            </div>
                          )}
                          <div className="provider-actions">
                            {connection ? (
                              <>
                                <button
                                  className="button button-secondary details-button"
                                  onClick={() =>
                                    setDialog({ type: "details", provider })
                                  }
                                  disabled={isBusy}
                                >
                                  View connection
                                </button>
                                <button
                                  className="button button-verify"
                                  aria-label={`Verify ${provider.name} connection`}
                                  title="Verify connection"
                                  onClick={() => void verify(provider)}
                                  disabled={!!busy}
                                >
                                  {isBusy ? (
                                    <Spinner />
                                  ) : (
                                    <Icon name="refresh" size={17} />
                                  )}
                                </button>
                              </>
                            ) : (
                              <button
                                className={`button ${provider.configured ? "button-connect" : "button-secondary"} full-width`}
                                onClick={() => void connect(provider)}
                                disabled={!!busy}
                              >
                                {isBusy ? (
                                  <>
                                    <Spinner /> Connecting…
                                  </>
                                ) : (
                                  <>
                                    <Icon name="plus" size={17} /> Connect
                                    account
                                  </>
                                )}
                              </button>
                            )}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </section>

              <div className="bottom-note">
                <div className="bottom-note-icon">
                  <Icon name="shield" size={20} />
                </div>
                <div>
                  <strong>Your accounts stay yours.</strong>
                  <p>
                    Connections verify access and show available accounts.
                    Permissions are managed by each platform.
                  </p>
                </div>
                <button
                  className="text-button"
                  onClick={() => setDialog({ type: "guide" })}
                >
                  How it works <Icon name="arrow" size={16} />
                </button>
              </div>
              <footer className="page-footer">
                <span>A little more connected. A lot less complicated.</span>
                <span>
                  Built around official APIs{" "}
                  <span className="footer-dot">·</span> Connector
                </span>
              </footer>
            </>
          ) : page === "pipeline" ? (
            <Pipeline
              providers={providers}
              origin={settings?.origin || window.location.origin}
              request={api}
              onAuthError={(error) => {
                if (error instanceof SessionExpiredError)
                  onLogout(error.message);
              }}
              onConnections={() => setPage("connections")}
              onSchedule={() => setPage("schedule")}
              onSettings={() => setPage("settings")}
            />
          ) : (
            <Schedule
              providers={providers}
              request={api}
              onAuthError={(error) => {
                if (error instanceof SessionExpiredError)
                  onLogout(error.message);
              }}
              onPipeline={() => setPage("pipeline")}
            />
          )}
        </main>
      </div>

      {dialog?.type === "api-key" && dialogProvider && (
        <ApiKeyDialog
          provider={dialogProvider}
          busy={busy === dialogProvider.id}
          onClose={() => setDialog(null)}
          onSubmit={(key, fields) => connectKey(dialogProvider, key, fields)}
        />
      )}
      {dialog?.type === "setup" && dialogProvider && (
        <Modal
          title={`Set up ${dialogProvider.name}`}
          className="setup-modal"
          onClose={() => setDialog(null)}
        >
          <ProviderSetup
            provider={dialogProvider}
            request={api}
            onCancel={() => setDialog(null)}
            onSaved={async () => {
              const updated = await refresh();
              await refreshSettings();
              const provider = updated.find(
                (item) => item.id === dialogProvider.id,
              );
              if (!provider?.configured)
                throw new Error(
                  "Some required application details are still missing. Complete the fields above to continue.",
                );
              setDialog(null);
              if (!configureOnly) await connect(provider);
              else
                setFeedback({
                  kind: "success",
                  message: `${provider.name} application settings saved.`,
                });
            }}
          />
        </Modal>
      )}
      {dialog?.type === "public-origin" && settings && (
        <Modal
          title="Continue in your public workspace"
          onClose={() => setDialog(null)}
        >
          <p className="dialog-copy">
            Your platform will return to your public address after sign-in. Open
            that workspace first, sign in with your chosen password, and click
            Connect account there.
          </p>
          <a className="button button-primary" href={settings.origin}>
            Open public workspace ↗
          </a>
        </Modal>
      )}
      {dialog?.type === "details" && dialogProvider?.connection && (
        <Modal
          title={`${dialogProvider.name} connection`}
          onClose={() => setDialog(null)}
          footer={
            <>
              <button
                className="button button-danger-subtle"
                onClick={() =>
                  setDialog({ type: "disconnect", provider: dialogProvider })
                }
              >
                Disconnect
              </button>
              <button
                className="button button-primary"
                onClick={() => {
                  setDialog(null);
                  void verify(dialogProvider);
                }}
                disabled={!!busy}
              >
                <Icon name="refresh" size={16} /> Verify connection
              </button>
            </>
          }
        >
          <div className="dialog-provider">
            <ProviderMark provider={dialogProvider} />
            <div>
              <strong>{dialogProvider.connection.accountName}</strong>
              <span
                className={
                  dialogProvider.connection.status === "error"
                    ? "error-text"
                    : ""
                }
              >
                {dialogProvider.connection.status === "connected"
                  ? "Connected through the official API"
                  : "This connection needs attention"}
              </span>
            </div>
          </div>
          {dialogProvider.connection.error && (
            <div className="inline-error" role="alert">
              <Icon name="alert" size={17} />
              <span>{dialogProvider.connection.error}</span>
            </div>
          )}
          <dl className="connection-details">
            <div>
              <dt>Platform</dt>
              <dd>{dialogProvider.name}</dd>
            </div>
            <div>
              <dt>Connection method</dt>
              <dd>
                {dialogProvider.authType === "link"
                  ? "Plaid secure bank sign-in"
                  : dialogProvider.authType === "oauth"
                    ? "OAuth authorization"
                    : dialogProvider.category === "ai"
                      ? "API key"
                      : "Developer access token"}
              </dd>
            </div>
            {dialogProvider.connection.accountId && (
              <div>
                <dt>Account ID</dt>
                <dd>
                  <code>{dialogProvider.connection.accountId}</code>
                </dd>
              </div>
            )}
            <div>
              <dt>Last verified</dt>
              <dd>{formatDate(dialogProvider.connection.lastVerifiedAt)}</dd>
            </div>
          </dl>
          <div className="resource-heading">
            <h3>Available resources</h3>
            <span>{dialogProvider.connection.resources.length}</span>
          </div>
          {dialogProvider.connection.resources.length ? (
            <ul className="resource-list">
              {dialogProvider.connection.resources.map((resource, index) => (
                <li key={`${resource.id}-${index}`}>
                  <span className="resource-icon">
                    <Icon name="layers" size={17} />
                  </span>
                  <div>
                    <strong>{resource.name}</strong>
                    <span>
                      {resource.type} <span aria-hidden="true">·</span>{" "}
                      {resource.id}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted-copy">
              The platform did not return additional resources for this account.
            </p>
          )}
          <a
            className="text-link"
            href={dialogProvider.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Platform documentation <Icon name="external" size={14} />
          </a>
        </Modal>
      )}
      {dialog?.type === "disconnect" && dialogProvider && (
        <Modal
          title={`Disconnect ${dialogProvider.name}?`}
          onClose={() => {
            if (!busy) setDialog(null);
          }}
          footer={
            <>
              <button
                className="button button-secondary"
                onClick={() => setDialog(null)}
                disabled={!!busy}
              >
                Keep connection
              </button>
              <button
                className="button button-danger"
                onClick={() => void disconnect(dialogProvider)}
                disabled={!!busy}
              >
                {busy ? (
                  <>
                    <Spinner /> Disconnecting…
                  </>
                ) : (
                  "Disconnect account"
                )}
              </button>
            </>
          }
        >
          <p className="dialog-copy">
            {dialogProvider.id === "plaid"
              ? "This revokes this bank connection through Plaid and removes its saved credentials from Connector. Your bank accounts are not closed. You can link the bank again later."
              : "This removes the saved credentials and account information from Connector. You can connect the account again at any time."}
          </p>
          <div className="info-note">
            <Icon name="help" size={18} />
            <p>
              {dialogProvider.id === "plaid" ? (
                "If Plaid cannot revoke the connection, Connector keeps it saved so you can retry."
              ) : (
                <>
                  To revoke the app’s authorization completely, also remove
                  Connector from your {dialogProvider.name} account settings.
                </>
              )}
            </p>
          </div>
        </Modal>
      )}
      {dialog?.type === "guide" && (
        <Modal
          title="A simple way to connect"
          onClose={() => setDialog(null)}
          footer={
            <button
              className="button button-primary"
              onClick={() => setDialog(null)}
            >
              Got it <Icon name="check" size={17} />
            </button>
          }
        >
          <p className="dialog-copy">
            Connector keeps your account connections in one private workspace.
            Each platform uses its official API.
          </p>
          <ol className="guide-steps">
            <li>
              <span>1</span>
              <div>
                <h3>Choose a platform</h3>
                <p>
                  AI providers use developer API keys. Other platforms use the
                  connection method shown on their card.
                </p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <h3>Authorize access</h3>
                <p>
                  For OAuth, sign in directly with the platform and review its
                  permissions. When application details are needed, the guided
                  form opens the developer portal and saves credentials
                  directly. No file editing or restart is needed.
                </p>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <h3>Verify your connection</h3>
                <p>
                  Connector checks access and lists the accounts or resources
                  returned by the API. Use the refresh icon on a card to verify
                  again.
                </p>
              </div>
            </li>
          </ol>
          <div className="info-note">
            <Icon name="shield" size={18} />
            <p>
              Credentials are encrypted on the server. Your workspace password
              protects access. Consumer AI subscriptions do not include
              developer API access.
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}

let desktopUnlock: Promise<void> | undefined;
function unlockFromDesktop() {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const token = hash.get("desktopToken") || hash.get("desktop");
  if (!token) return desktopUnlock || Promise.resolve();
  hash.delete("desktopToken");
  hash.delete("desktop");
  const remaining = hash.toString();
  window.history.replaceState(
    {},
    "",
    `${window.location.pathname}${window.location.search}${remaining ? `#${remaining}` : ""}`,
  );
  desktopUnlock = api("/api/desktop/unlock", {
    method: "POST",
    body: JSON.stringify({ token }),
  })
    .then(() => undefined)
    .catch(async (error) => {
      const session = await api<{ authenticated: boolean }>("/api/session");
      if (!session.authenticated) throw error;
    });
  return desktopUnlock;
}

export default function App() {
  const [session, setSession] = useState<
    "loading" | "authenticated" | "unauthenticated" | "error"
  >("loading");
  const [error, setError] = useState("");
  const checkSession = useCallback(async () => {
    setSession("loading");
    setError("");
    try {
      await unlockFromDesktop();
      const result = await api<{ authenticated: boolean }>("/api/session");
      setSession(result.authenticated ? "authenticated" : "unauthenticated");
    } catch (cause) {
      if (cause instanceof SessionExpiredError) setSession("unauthenticated");
      else {
        setSession("error");
        setError(errorMessage(cause));
      }
    }
  }, []);
  useEffect(() => {
    void checkSession();
    const handleDesktopLink = () => {
      const hash = new URLSearchParams(window.location.hash.slice(1));
      if (hash.has("desktopToken") || hash.has("desktop")) void checkSession();
    };
    window.addEventListener("hashchange", handleDesktopLink);
    return () => window.removeEventListener("hashchange", handleDesktopLink);
  }, [checkSession]);
  const loggedOut = useCallback((message?: string) => {
    setError(message || "");
    setSession("unauthenticated");
  }, []);
  if (session === "loading")
    return (
      <main className="app-loading">
        <Brand />
        <div role="status">
          <Spinner />
          <span>Opening your workspace…</span>
        </div>
      </main>
    );
  if (session === "error")
    return (
      <main className="app-loading">
        <Brand />
        <div className="startup-error" role="alert">
          <h1>Unable to open your workspace</h1>
          <p>{error}</p>
          <button
            className="button button-primary"
            onClick={() => void checkSession()}
          >
            <Icon name="refresh" size={17} /> Try again
          </button>
        </div>
      </main>
    );
  if (session === "unauthenticated")
    return (
      <Login
        onSuccess={() => {
          setError("");
          setSession("authenticated");
        }}
        initialError={error}
      />
    );
  return <Dashboard onLogout={loggedOut} />;
}
