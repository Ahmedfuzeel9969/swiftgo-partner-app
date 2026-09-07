package com.swiftgo.partner;
import android.content.Context;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.nio.file.Files;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;
/** Must run on an isolated emulator, never against an installed live user's app. */
public class SecureLocationStoreTest {
  @Test public void encryptedRoundTripAndTamperFailClosed() throws Exception {
    Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    assertEquals("com.swiftgo.partner.verification", context.getPackageName());
    SecureLocationStore store = new SecureLocationStore(context);
    store.clear();
    try {
      store.write(new JSONObject().put("token", "synthetic-secret").put("lat", 12.34));
      File file = new File(context.getNoBackupFilesDir(), "location-session-v2.bin");
      byte[] ciphertext = Files.readAllBytes(file.toPath());
      assertFalse(new String(ciphertext, java.nio.charset.StandardCharsets.UTF_8).contains("synthetic-secret"));
      assertEquals("synthetic-secret", store.read().getString("token"));
      ciphertext[ciphertext.length - 1] ^= 1;
      Files.write(file.toPath(), ciphertext);
      try { store.read(); fail("Tampered state was accepted"); } catch (javax.crypto.AEADBadTagException expected) {}
    } finally { store.clear(); }
    assertNull(store.read());
  }
}
