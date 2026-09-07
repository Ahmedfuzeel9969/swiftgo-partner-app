package com.swiftgo.partner;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import org.json.JSONObject;

/** One atomic authenticated snapshot; never backed up, never a plaintext fallback. */
final class SecureLocationStore {
  private static final String ALIAS = "swiftgo.background.location.v2";
  private final AtomicFile file;
  private final byte[] aad;
  SecureLocationStore(Context context) {
    file = new AtomicFile(new File(context.getNoBackupFilesDir(), "location-session-v2.bin"));
    aad = (context.getPackageName() + ":location-session:v2").getBytes(StandardCharsets.UTF_8);
  }
  private SecretKey key(boolean create) throws Exception {
    KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
    ks.load(null);
    if (ks.containsAlias(ALIAS)) return (SecretKey) ks.getKey(ALIAS, null);
    if (!create) throw new IllegalStateException("KEY_UNAVAILABLE");
    KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
    generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256).setRandomizedEncryptionRequired(true).build());
    return generator.generateKey();
  }
  JSONObject read() throws Exception {
    if (!file.getBaseFile().exists()) return null;
    if (file.getBaseFile().length() > 64_000L) throw new IllegalStateException("STATE_TOO_LARGE");
    byte[] bytes = file.readFully();
    byte[] plain = AuthenticatedEnvelope.decrypt(bytes, key(false), aad);
    return new JSONObject(new String(plain, StandardCharsets.UTF_8));
  }
  void write(JSONObject state) throws Exception {
    byte[] plain = state.toString().getBytes(StandardCharsets.UTF_8);
    if (plain.length > 60_000) throw new IllegalStateException("STATE_TOO_LARGE");
    byte[] bytes = AuthenticatedEnvelope.encrypt(plain, key(true), aad);
    FileOutputStream out = null;
    try {
      out = file.startWrite();
      out.write(bytes);
      file.finishWrite(out);
    } catch (Exception e) {
      if (out != null) file.failWrite(out);
      throw e;
    }
  }
  void clear() { file.delete(); }
  static void discardLegacy(Context context) {
    // Old unbound plaintext tokens cannot safely be migrated into a new assignment.
    context.getSharedPreferences("swiftgo_bg_location", Context.MODE_PRIVATE).edit().clear().commit();
    context.getSharedPreferences("swiftgo_driver_location_binding", Context.MODE_PRIVATE).edit().clear().commit();
    File legacy = new File(context.getFilesDir(), "bg_location_queue.json");
    if (legacy.exists() && !legacy.delete()) throw new IllegalStateException("LEGACY_CLEAR_FAILED");
  }
}
