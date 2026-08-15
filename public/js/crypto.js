/**
 * P-Chat Standard Web Crypto Engine
 * 
 * Cryptographic Standard:
 * - PBKDF2-SHA256 (100,000 iterations + salt) for key derivation
 * - AES-256-GCM (Authenticated Encryption with 96-bit unique IV & 128-bit auth tag)
 * - SHA-256 for zero-knowledge server hash verifier
 */

class PCrypto {
  static isAvailable() {
    return Boolean(window.crypto && window.crypto.subtle);
  }

  /**
   * Generate unambiguous high-entropy random password
   */
  static generateStrongPassword(length = 12) {
    const charset = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz#$@!';
    const randomValues = new Uint8Array(length);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(randomValues);
    } else {
      for (let i = 0; i < length; i++) {
        randomValues[i] = Math.floor(Math.random() * 256);
      }
    }
    let result = '';
    for (let i = 0; i < length; i++) {
      result += charset[randomValues[i] % charset.length];
    }
    return result;
  }

  /**
   * Safe chunked Uint8Array to Base64 conversion (prevents Call Stack Exceeded on large files)
   */
  static uint8ToBase64(uint8) {
    let binary = '';
    const len = uint8.byteLength;
    const chunkSize = 0x8000; // 32KB chunks
    for (let i = 0; i < len; i += chunkSize) {
      binary += String.fromCharCode.apply(
        null,
        uint8.subarray(i, Math.min(i + chunkSize, len))
      );
    }
    return btoa(binary);
  }

  /**
   * Safe Base64 to Uint8Array conversion
   */
  static base64ToUint8(base64) {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * Calculate SHA-256 hash in hex (zero-knowledge verifier for server)
   */
  static async sha256(str) {
    if (!str) return null;
    if (!PCrypto.isAvailable()) {
      throw new Error('WebCrypto_Unavailable: 浏览器禁用了密码学 API，请使用 HTTPS 或 Localhost 访问');
    }
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
    if (!PCrypto.isAvailable()) {
      throw new Error('WebCrypto_Unavailable: 浏览器禁用了密码学 API，请使用 HTTPS 或 Localhost 访问');
    }

    if (!password) {
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
    if (!PCrypto.isAvailable()) {
      throw new Error('WebCrypto_Unavailable: 浏览器禁用了密码学 API，请使用 HTTPS 或 Localhost 访问');
    }

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
    const ciphertextBase64 = PCrypto.uint8ToBase64(new Uint8Array(cipherBuffer));

    return {
      iv: ivHex,
      ciphertext: ciphertextBase64
    };
  }

  /**
   * Decrypt AES-256-GCM ciphertext
   */
  static async decrypt(ivHex, ciphertextBase64, cryptoKey) {
    if (!PCrypto.isAvailable()) {
      return '[⚠️ 浏览器禁用了解密 API，请使用 HTTPS 或 Localhost 访问]';
    }

    try {
      const iv = new Uint8Array(ivHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
      const cipherBytes = PCrypto.base64ToUint8(ciphertextBase64);

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
      return '[⚠️ 密文解密失败：口令不匹配或数据已损坏]';
    }
  }
}

window.PCrypto = PCrypto;
