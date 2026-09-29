import bs58 from 'bs58';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import { Keypair } from '@solana/web3.js';

/**
 * Parses a single secret line into a Solana Keypair.
 * Supported formats:
 * 1. 12 or 24 word BIP-39 mnemonic phrase (derived via m/44'/501'/${index}'/0')
 * 2. Base58 encoded 64-byte secret key
 * 3. Base58 encoded 32-byte private seed
 * 4. JSON array of 64 or 32 uint8 numbers (e.g. [12, 34, ...])
 *
 * @param {string} rawLine
 * @param {number} derivationIndex (default 0)
 * @returns {Keypair}
 */
export function parseSecret(rawLine, derivationIndex = 0) {
  if (!rawLine || typeof rawLine !== 'string') {
    throw new Error('Empty secret');
  }

  let trimmed = rawLine.trim();

  // Strip trailing comments if any
  const commentIndex = trimmed.indexOf('#');
  if (commentIndex !== -1) {
    trimmed = trimmed.substring(0, commentIndex).trim();
  }

  if (!trimmed) {
    throw new Error('Empty secret line');
  }

  // 1. JSON Array format: [1, 2, 3, ...]
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed) || (parsed.length !== 64 && parsed.length !== 32)) {
        throw new Error(`JSON array must contain 32 or 64 numbers (found ${parsed?.length || 0})`);
      }
      const u8 = Uint8Array.from(parsed);
      if (u8.length === 64) {
        try {
          return Keypair.fromSecretKey(u8);
        } catch {
          return Keypair.fromSeed(u8.slice(0, 32));
        }
      } else {
        return Keypair.fromSeed(u8);
      }
    } catch (err) {
      throw new Error(`Invalid JSON array secret: ${err.message}`);
    }
  }

  // 2. Mnemonic phrase (words separated by whitespace)
  const words = trimmed.split(/\s+/);
  if (words.length >= 12 && words.length <= 24) {
    const mnemonic = words.join(' ').toLowerCase();
    if (bip39.validateMnemonic(mnemonic)) {
      const seed = bip39.mnemonicToSeedSync(mnemonic);
      const accIndex = Number.isInteger(derivationIndex) && derivationIndex >= 0 ? derivationIndex : 0;
      const path = `m/44'/501'/${accIndex}'/0'`;
      const derived = derivePath(path, seed.toString('hex')).key;
      return Keypair.fromSeed(derived);
    }
    throw new Error('Invalid mnemonic phrase (checksum failed or unrecognized words)');
  }

  // 3. Base58 encoded secret key or seed
  try {
    const decoded = bs58.decode(trimmed);
    if (decoded.length === 64) {
      try {
        return Keypair.fromSecretKey(decoded);
      } catch {
        return Keypair.fromSeed(decoded.slice(0, 32));
      }
    } else if (decoded.length === 32) {
      return Keypair.fromSeed(decoded);
    } else {
      throw new Error(`Base58 string decoded to unexpected length: ${decoded.length} bytes (expected 32 or 64)`);
    }
  } catch (err) {
    throw new Error(`Unrecognized secret format or invalid base58: ${err.message}`);
  }
}

/**
 * Parses multiline secrets text.
 * Ignores empty lines and lines starting with '#'
 * Deduplicates by public key.
 * Keeps valid keys and tracks errors with line numbers.
 *
 * @param {string} text
 * @param {number} derivationIndex
 * @returns {{ validWallets: Array<{ keypair: Keypair, publicKey: string, lineNumber: number }>, invalidLines: Array<{ lineNumber: number, lineContentSnippet: string, error: string }> }}
 */
export function parseSecretsText(text, derivationIndex = 0) {
  if (!text || typeof text !== 'string') {
    return { validWallets: [], invalidLines: [] };
  }

  const lines = text.split(/\r?\n/);
  const validWallets = [];
  const invalidLines = [];
  const seenPublicKeys = new Set();

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const lineNumber = i + 1;
    let trimmed = rawLine.trim();

    // Ignore empty lines and lines starting with #
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // Strip inline comments if any
    const commentIdx = trimmed.indexOf('#');
    if (commentIdx !== -1) {
      trimmed = trimmed.substring(0, commentIdx).trim();
      if (!trimmed) {
        continue;
      }
    }

    try {
      const kp = parseSecret(trimmed, derivationIndex);
      const pubkeyStr = kp.publicKey.toBase58();

      if (seenPublicKeys.has(pubkeyStr)) {
        // Skip duplicate
        continue;
      }

      seenPublicKeys.add(pubkeyStr);
      validWallets.push({
        keypair: kp,
        publicKey: pubkeyStr,
        lineNumber,
        secret: trimmed
      });
    } catch (err) {
      // Create a masked snippet to prevent exposing secret while letting user identify line
      let snippet = trimmed;
      if (snippet.length > 12) {
        snippet = snippet.slice(0, 4) + '...' + snippet.slice(-4);
      }
      invalidLines.push({
        lineNumber,
        lineContentSnippet: snippet,
        error: err.message
      });
    }
  }

  return { validWallets, invalidLines };
}
