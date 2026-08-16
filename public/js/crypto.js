/**
 * P-Chat Standard Web Crypto Engine
 * 
 * Cryptographic Standard:
 * - PBKDF2-SHA256 (100,000 iterations + salt) for key derivation
 * - AES-256-GCM (Authenticated Encryption with 96-bit unique IV & 128-bit auth tag)
 * - SHA-256 for zero-knowledge server hash verifier
 * - Zero-Copy Native Binary ArrayBuffer Frame Protocol (0% Base64 Overhead)
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
   * Raw Binary Pack: Packs Metadata + Native Encrypted Binary into 1:1 Wire Frame
   * Protocol Format:
   * [0..3]   : Magic "PCHT" (4B)
   * [4..15]  : 12-byte random IV (12B)
   * [16..19] : Meta JSON length (4B Uint32BE)
   * [20..20+metaLen-1] : UTF-8 Meta JSON
   * [20+metaLen..end]  : AES-256-GCM Ciphertext ArrayBuffer
   */
  static async packBinaryFrame(metaObject, plainBuffer, cryptoKey) {
    if (!PCrypto.isAvailable()) {
      throw new Error('WebCrypto_Unavailable');
    }

    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);

    // Encrypt raw ArrayBuffer
    const cipherBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv },
      cryptoKey,
      plainBuffer
    );

    const metaBytes = new TextEncoder().encode(JSON.stringify(metaObject));
    const metaLen = metaBytes.length;

    const totalLen = 4 + 12 + 4 + metaLen + cipherBuffer.byteLength;
    const packet = new Uint8Array(totalLen);

    // 1. Magic
    packet[0] = 0x50; packet[1] = 0x43; packet[2] = 0x48; packet[3] = 0x54; // "PCHT"
    // 2. IV
    packet.set(iv, 4);
    // 3. Meta Length
    const view = new DataView(packet.buffer);
    view.setUint32(16, metaLen, false); // Big-Endian
    // 4. Meta Bytes
    packet.set(metaBytes, 20);
    // 5. Ciphertext
    packet.set(new Uint8Array(cipherBuffer), 20 + metaLen);

    return packet.buffer;
  }

  /**
   * Unpack Binary Frame Header and Extract Ciphertext
   */
  static unpackBinaryFrame(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    if (view.byteLength < 20) return null;

    // Check magic
    if (view.getUint8(0) !== 0x50 || view.getUint8(1) !== 0x43 ||
        view.getUint8(2) !== 0x48 || view.getUint8(3) !== 0x54) {
      return null;
    }

    const iv = new Uint8Array(arrayBuffer, 4, 12);
    const metaLen = view.getUint32(16, false);

    if (view.byteLength < 20 + metaLen) return null;

    const metaBytes = new Uint8Array(arrayBuffer, 20, metaLen);
    const metaJson = new TextDecoder().decode(metaBytes);
    const meta = JSON.parse(metaJson);

    const cipherBuffer = arrayBuffer.slice(20 + metaLen);

    return {
      iv: iv,
      meta: meta,
      cipherBuffer: cipherBuffer
    };
  }

  /**
   * Decrypt Native Binary Ciphertext into Plain ArrayBuffer
   */
  static async decryptBinary(ivUint8Array, cipherArrayBuffer, cryptoKey) {
    if (!PCrypto.isAvailable()) {
      throw new Error('WebCrypto_Unavailable');
    }
    return await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivUint8Array },
      cryptoKey,
      cipherArrayBuffer
    );
  }
}

window.PCrypto = PCrypto;
