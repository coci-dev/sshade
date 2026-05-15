/**
 * Catalog of AI providers sshade can talk to.
 *
 * Native providers (Anthropic, OpenAI, Google) use their own protocol.
 * Everything else speaks OpenAI dialect and is routed through createOpenAI
 * with a custom baseURL.
 */

export type ProviderId =
  | "anthropic"
  | "openai"
  | "google"
  | "deepseek"
  | "nvidia"
  | "groq"
  | "ollama"
  | "custom";

export interface ProviderMeta {
  id: ProviderId;
  name: string;
  /** Known good models for the dropdown. Empty array = freeform input. */
  models: string[];
  defaultModel: string;
  defaultBaseURL?: string;
  needsKey: boolean;
  needsBaseURL: boolean;
  hint?: string;
  signupUrl?: string;
}

export const PROVIDERS: Record<ProviderId, ProviderMeta> = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic (Claude)",
    models: ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
    defaultModel: "claude-sonnet-4-6",
    needsKey: true,
    needsBaseURL: false,
    hint: "Paid (Haiku ≈ $0.80/M tokens). Sign up at console.anthropic.com.",
    signupUrl: "https://console.anthropic.com",
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    models: ["gpt-4o", "gpt-4o-mini", "o3-mini", "o1-mini"],
    defaultModel: "gpt-4o-mini",
    needsKey: true,
    needsBaseURL: false,
    hint: "Paid. Sign up at platform.openai.com.",
    signupUrl: "https://platform.openai.com",
  },
  google: {
    id: "google",
    name: "Google Gemini",
    models: [
      "gemini-1.5-flash",
      "gemini-1.5-flash-8b",
      "gemini-1.5-pro",
      "gemini-2.0-flash",
      "gemini-2.0-pro-exp",
    ],
    defaultModel: "gemini-1.5-flash",
    needsKey: true,
    needsBaseURL: false,
    hint: "Free tier: try gemini-1.5-flash first (15 req/min, 1500/day). 2.0 models need higher-tier projects.",
    signupUrl: "https://aistudio.google.com/apikey",
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    models: ["deepseek-chat", "deepseek-reasoner"],
    defaultModel: "deepseek-chat",
    defaultBaseURL: "https://api.deepseek.com/v1",
    needsKey: true,
    needsBaseURL: true,
    hint: "Very cheap (~$0.27/M input). platform.deepseek.com.",
    signupUrl: "https://platform.deepseek.com",
  },
  nvidia: {
    id: "nvidia",
    name: "NVIDIA NIM",
    models: [
      "meta/llama-3.3-70b-instruct",
      "meta/llama-3.1-405b-instruct",
      "nvidia/llama-3.1-nemotron-70b-instruct",
      "deepseek-ai/deepseek-r1",
      "qwen/qwen2.5-coder-32b-instruct",
      "mistralai/mixtral-8x22b-instruct-v0.1",
    ],
    defaultModel: "meta/llama-3.3-70b-instruct",
    defaultBaseURL: "https://integrate.api.nvidia.com/v1",
    needsKey: true,
    needsBaseURL: true,
    hint: "Free dev credits. build.nvidia.com.",
    signupUrl: "https://build.nvidia.com",
  },
  groq: {
    id: "groq",
    name: "Groq (fast Llama)",
    models: [
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
      "mixtral-8x7b-32768",
      "qwen-2.5-32b",
    ],
    defaultModel: "llama-3.3-70b-versatile",
    defaultBaseURL: "https://api.groq.com/openai/v1",
    needsKey: true,
    needsBaseURL: true,
    hint: "Free tier with generous rate limits. console.groq.com.",
    signupUrl: "https://console.groq.com",
  },
  ollama: {
    id: "ollama",
    name: "Ollama (local)",
    models: ["llama3.2", "qwen2.5-coder:7b", "mistral", "deepseek-r1:7b"],
    defaultModel: "llama3.2",
    defaultBaseURL: "http://localhost:11434/v1",
    needsKey: false,
    needsBaseURL: true,
    hint: "Free + private. Install Ollama and run `ollama pull <model>` first.",
    signupUrl: "https://ollama.com",
  },
  custom: {
    id: "custom",
    name: "Custom (OpenAI-compatible)",
    models: [],
    defaultModel: "",
    needsKey: true,
    needsBaseURL: true,
    hint: "Any OpenAI-compatible endpoint (OpenRouter, Together, vLLM, etc.).",
  },
};

export const PROVIDER_ORDER: ProviderId[] = [
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "nvidia",
  "groq",
  "ollama",
  "custom",
];
