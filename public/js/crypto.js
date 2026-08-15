/**
 * P-Chat Web Crypto Engine
 * 
 * Hardware-accelerated Web Crypto API:
 * - PBKDF2-SHA256 (100,000 iterations) for Key Derivation
 * - AES-256-GCM (Authenticated Encryption with 96-bit random IV)
 * - SHA-256 for zero-knowledge server hash verification
 */

class PCrypto {
  /**
   * Generate an unambiguous high-entropy random password
   * (Length: 12 chars, excluded confusing characters like 0/O/1/l/I)
   */
  static generateStrongPassword(length = 12) {
    const charset = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz#$@!';
    const randomValues = new Uint8Array(length);
    crypto.getRandomValues(randomValues);
    let result = '';
    for (let i = 0; i < length; i++) {
      result += charset[randomValues[i] % charset.length];
    }
    return result;
  }

  /**
   * Calculate SHA-256 hash in hex (used as zero-knowledge verifier for server)
   */
  static async sha256(str) {
    if (!str) return null;
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Derive AES-256-GCM CryptoKey from password string via PBKDF2
   */
  static async deriveKey(password, saltString = 'P-CHAT-CONSTANT-SALT-V1') {
    if (!password) {
      // Return a fixed dummy key for completely passwordless public rooms
      password = 'PUBLIC-UNENCRYPTED-FALLBACK-KEY';
    }
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );

    const salt = encoder.encode(saltString);

    const derivedKey = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: 100000,
        hash: 'SHA-256'
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    return derivedKey;
  }

  /**
   * Encrypt plaintext string using AES-256-GCM
   * Returns: { iv: hexString, ciphertext: base64String }
   */
  static async encrypt(plaintext, cryptoKey) {
    const encoder = new TextEncoder();
    const encodedData = encoder.encode(plaintext);

    // 96-bit (12 bytes) IV standard for AES-GCM
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);

    const cipherBuffer = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv
      },
      cryptoKey,
      encodedData
    );

    const ivHex = Array.from(iv).map(b => b.toString(16).padStart(2, '0')).join('');
    const ciphertextBase64 = btoa(String.fromCharCode(...new Uint8Array(cipherBuffer)));

    return {
      iv: ivHex,
      ciphertext: ciphertextBase64
    };
  }

  /**
   * Decrypt AES-256-GCM ciphertext
   */
  static async decrypt(ivHex, ciphertextBase64, cryptoKey) {
    try {
      const iv = new Uint8Array(ivHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
      const binaryString = atob(ciphertextBase64);
      const cipherBytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        cipherBytes[i] = binaryString.charCodeAt(i);
      }

      const decryptedBuffer = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: iv
        },
        cryptoKey,
        cipherBytes
      );

      const decoder = new TextDecoder();
      return decoder.decode(decryptedBuffer);
    } catch (e) {
      console.error('[PCrypto] Decryption error:', e);
      return '[⚠️ 密文解密失败：口令不匹配或数据损坏]';
    }
  }
}

window.PCrypto = PCrypto;
