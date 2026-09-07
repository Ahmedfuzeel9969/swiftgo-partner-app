package com.swiftgo.p2p;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import java.io.*;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/** Authenticated, atomic, no-backup hand-off state. No plaintext fallback. */
public final class NativeP2pStore {
  private static final byte[] MAGIC = new byte[]{'S','G','P','2',1};
  private final String alias;
  private final AtomicFile file;

  public NativeP2pStore(Context context, String role) {
    alias = "swiftgo_native_p2p_" + role + "_v1";
    file = new AtomicFile(new File(context.getNoBackupFilesDir(), "native-p2p-" + role + ".bin"));
  }

  private SecretKey key() throws Exception {
    KeyStore store = KeyStore.getInstance("AndroidKeyStore");
    store.load(null);
    if (store.containsAlias(alias)) return (SecretKey) store.getKey(alias, null);
    KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
    generator.init(new KeyGenParameterSpec.Builder(alias,
      KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256).setRandomizedEncryptionRequired(true).build());
    return generator.generateKey();
  }

  public synchronized void write(JSONObject value) throws Exception {
    byte[] clear = value.toString().getBytes(StandardCharsets.UTF_8);
    if (clear.length > 64_000) throw new IOException("STATE_TOO_LARGE");
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.ENCRYPT_MODE, key());
    byte[] iv = cipher.getIV(), encrypted = cipher.doFinal(clear);
    ByteBuffer bytes = ByteBuffer.allocate(MAGIC.length + 1 + iv.length + encrypted.length);
    bytes.put(MAGIC).put((byte) iv.length).put(iv).put(encrypted);
    FileOutputStream output = null;
    try {
      output = file.startWrite(); output.write(bytes.array()); file.finishWrite(output); output = null;
    } finally { if (output != null) file.failWrite(output); }
  }

  public synchronized JSONObject read() throws Exception {
    byte[] bytes;
    try (FileInputStream input = file.openRead(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
      byte[] chunk = new byte[4096]; int n;
      while ((n = input.read(chunk)) != -1) {
        if (out.size() + n > 70_000) throw new IOException("STATE_TOO_LARGE");
        out.write(chunk, 0, n);
      }
      bytes = out.toByteArray();
    }
    ByteBuffer buffer = ByteBuffer.wrap(bytes);
    for (byte expected : MAGIC) if (!buffer.hasRemaining() || buffer.get() != expected) throw new IOException("BAD_MAGIC");
    int ivLength = buffer.get() & 0xff;
    if (ivLength < 12 || ivLength > 32 || buffer.remaining() <= ivLength) throw new IOException("BAD_ENVELOPE");
    byte[] iv = new byte[ivLength], encrypted = new byte[buffer.remaining() - ivLength];
    buffer.get(iv).get(encrypted);
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
    return new JSONObject(new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8));
  }

  public synchronized void clear() { file.delete(); }
}
