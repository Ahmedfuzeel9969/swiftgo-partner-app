package com.swiftgo.partner;

import java.nio.ByteBuffer;
import java.security.GeneralSecurityException;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Versioned AES-GCM envelope, shared by Android storage and JVM crypto tests. */
final class AuthenticatedEnvelope {
  static byte[] encrypt(byte[] plain, SecretKey key, byte[] aad) throws GeneralSecurityException {
    if (plain.length > 60_000) throw new GeneralSecurityException("STATE_TOO_LARGE");
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.ENCRYPT_MODE, key);
    cipher.updateAAD(aad);
    byte[] encrypted = cipher.doFinal(plain);
    if (cipher.getIV().length != 12) throw new GeneralSecurityException("INVALID_IV_SIZE");
    return ByteBuffer.allocate(13 + encrypted.length).put((byte) 2).put(cipher.getIV()).put(encrypted).array();
  }
  static byte[] decrypt(byte[] bytes, SecretKey key, byte[] aad) throws GeneralSecurityException {
    if (bytes.length < 29 || bytes.length > 64_000 || bytes[0] != 2) throw new GeneralSecurityException("INVALID_STATE");
    byte[] iv = new byte[12]; System.arraycopy(bytes, 1, iv, 0, 12);
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
    cipher.updateAAD(aad);
    return cipher.doFinal(bytes, 13, bytes.length - 13);
  }
}
