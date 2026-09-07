package com.swiftgo.partner;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import org.junit.Test;
import static org.junit.Assert.*;
public class AuthenticatedEnvelopeTest {
  private static byte[] bytes(String value) { return value.getBytes(StandardCharsets.UTF_8); }
  private static SecretKey key() throws Exception { KeyGenerator g = KeyGenerator.getInstance("AES"); g.init(256); return g.generateKey(); }
  @Test public void roundTripNeverStoresPlaintext() throws Exception {
    SecretKey key = key(); byte[] plain = bytes("synthetic-token-and-location");
    byte[] sealed = AuthenticatedEnvelope.encrypt(plain, key, bytes("app:2"));
    assertArrayEquals(plain, AuthenticatedEnvelope.decrypt(sealed, key, bytes("app:2")));
    assertFalse(new String(sealed, StandardCharsets.UTF_8).contains("synthetic-token"));
  }
  @Test public void uniqueIvForEveryWrite() throws Exception {
    SecretKey key = key();
    assertFalse(Arrays.equals(AuthenticatedEnvelope.encrypt(bytes("a"), key, bytes("app")),
      AuthenticatedEnvelope.encrypt(bytes("a"), key, bytes("app"))));
  }
  @Test public void ciphertextAndIvTamperingRejected() throws Exception {
    SecretKey key = key(); byte[] sealed = AuthenticatedEnvelope.encrypt(bytes("a"), key, bytes("app"));
    for (int offset : new int[]{1, 12, 13, sealed.length - 1}) {
      byte[] corrupt = sealed.clone(); corrupt[offset] ^= 1;
      assertThrows(java.security.GeneralSecurityException.class, () -> AuthenticatedEnvelope.decrypt(corrupt, key, bytes("app")));
    }
  }
  @Test public void differentAppCannotDecrypt() throws Exception {
    SecretKey key = key(); byte[] sealed = AuthenticatedEnvelope.encrypt(bytes("a"), key, bytes("partner"));
    assertThrows(java.security.GeneralSecurityException.class, () -> AuthenticatedEnvelope.decrypt(sealed, key, bytes("customer")));
  }
  @Test public void lostOrChangedKeyCannotDecrypt() throws Exception {
    byte[] sealed = AuthenticatedEnvelope.encrypt(bytes("a"), key(), bytes("app")); SecretKey other = key();
    assertThrows(java.security.GeneralSecurityException.class, () -> AuthenticatedEnvelope.decrypt(sealed, other, bytes("app")));
  }
  @Test public void wrongVersionTruncationAndOversizeRejected() throws Exception {
    SecretKey key = key(); byte[] sealed = AuthenticatedEnvelope.encrypt(bytes("a"), key, bytes("app")); sealed[0] = 1;
    assertThrows(java.security.GeneralSecurityException.class, () -> AuthenticatedEnvelope.decrypt(sealed, key, bytes("app")));
    assertThrows(java.security.GeneralSecurityException.class, () -> AuthenticatedEnvelope.decrypt(new byte[8], key, bytes("app")));
    assertThrows(java.security.GeneralSecurityException.class, () -> AuthenticatedEnvelope.encrypt(new byte[60_001], key, bytes("app")));
  }
}
