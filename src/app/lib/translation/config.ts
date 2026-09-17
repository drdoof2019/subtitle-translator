// Config migration utilities. Provider data lives in `./registry`.

import type { TranslationConfig } from "./types";

export const DEFAULT_SYSTEM_PROMPT = "You are a professional subtitle translator. Respond only with the translated content, preserving the exact line numbers and formatting without explanations or commentary. Treat multi-line sentence fragments as a single continuous sentence: reconstruct the complete thought first, translate it into the fully natural syntax, word order, and grammar of the target language, and then split the translated sentence across the corresponding lines so that the reading flow remains completely natural while maintaining equal line distribution. Never translate split phrases word-for-word in their original linear order.";
export const DEFAULT_USER_PROMPT = "Translate the following subtitle lines into natural, idiomatic ${targetLanguage}. Reorder words and phrases so the sentence structure flows properly in ${targetLanguage}, but ensure the translated parts are distributed cleanly across the exact same number of lines without merging or skipping:\n\n${content}";

// Fields to preserve when resetting config to defaults (user credentials should not be lost).
// apiVersion (Azure OpenAI), region (Azure Translate), and folderId (Yandex) are effectively
// credential-adjacent — users set them once per deployment/tenant and don't expect a reset
// to forget them.
const PRESERVE_FIELDS: (keyof TranslationConfig)[] = ["apiKey", "url", "apiVersion", "region", "folderId"];

/**
 * Reset config to defaults while preserving user credential fields (apiKey, url, apiVersion, region, folderId).
 * Used by the explicit "Reset" button.
 */
export const resetConfigWithCredentials = (currentConfig: TranslationConfig | undefined, defaultConfig: TranslationConfig | undefined): TranslationConfig => {
  const preserved: Partial<TranslationConfig> = {};
  if (currentConfig) {
    for (const field of PRESERVE_FIELDS) {
      if (currentConfig[field] !== undefined) {
        (preserved as Record<string, unknown>)[field] = currentConfig[field];
      }
    }
  }
  return { ...defaultConfig, ...preserved };
};

/**
 * Graceful config migration for stored user configs.
 *
 * When defaults evolve (new fields added, old fields removed), this merges
 * defaults into the saved config so missing fields get backfilled and obsolete
 * fields get pruned — without resetting the user's valid choices (model,
 * temperature, apiKey, ...). Explicit user-initiated resets should still call
 * resetConfigWithCredentials.
 */
export const migrateConfig = (saved: TranslationConfig | undefined, defaults: TranslationConfig | undefined): TranslationConfig => {
  if (!defaults) return { ...(saved ?? {}) };
  if (!saved) return { ...defaults };
  const merged: Record<string, unknown> = { ...defaults, ...saved };
  // Drop keys that no longer exist in defaults (removed fields)
  for (const key of Object.keys(merged)) {
    if (!(key in defaults)) delete merged[key];
  }
  return merged as TranslationConfig;
};
