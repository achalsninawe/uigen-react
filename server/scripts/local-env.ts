/**
 * Forces a verification run onto local, throwaway storage.
 *
 * Imported before anything that reads `config`, which loads `.env` at import
 * time — and that `.env` points at the real Azure account. A verification
 * writing a throwaway project into live storage would be a poor trade for the
 * confidence it buys.
 *
 * `dotenv` does not overwrite variables that are already set, so assigning
 * them here wins over the file.
 */

process.env.AZURE_STORAGE_CONNECTION_STRING = ''
process.env.WORK_DIR ??= './.work/verify-store'
process.env.SESSION_SECRET ??= 'verification-only-never-a-real-secret'

export const usingLocalStorage = true
