/**
 * SPEC ONLY — Phase 1 (pre-match) + Phase 2 (post-contact) location / dispatch rules.
 *
 * Source: operator Urdu specification (final).
 * This file is documentation-as-code. It must NOT change runtime behaviour by itself.
 * Do not add, remove, or reinterpret rules here.
 *
 * Phase 1 and Phase 2 are fully separate systems:
 * - No Phase 1 condition may affect Phase 2.
 * - No Phase 2 condition may affect Phase 1.
 * Each phase runs independently under its own rules.
 */

export const SPEC_META = Object.freeze({
  title: "Phase1_Phase2_Location_Dispatch_Spec",
  version: "1.0.0-operator-final",
  languageSource: "urdu",
  phaseIsolation: "strict",
  status: "SPEC_ONLY_NOT_WIRED",
});

/* -------------------------------------------------------------------------- */
/* Phase 1 — Before ride is matched / offered path (driver location system)   */
/* -------------------------------------------------------------------------- */

export const PHASE1 = Object.freeze({
  name: "phase1_pre_match_driver_location_system",

  /** §1 Driver online / eligible to receive rides — ALL must be true */
  driverEligibleForRideOffers: Object.freeze({
    mustHaveNoActiveRide: true,
    mustBeOnline: true,
    mustHaveDeviceLocationServiceOn: true,
    mustHaveInAppLocationPermissionOn: true,
    note: "Only when ALL of the above are true is the driver included in the ride-offer driver list.",
  }),

  /** §2 Firebase location update triggers (whichever of distance/time comes first) */
  firebaseLocationUpdate: Object.freeze({
    onFirstLocationEnable: true,
    onLocationReEnableAfterAnyOff: true,
    distanceMeters: 200,
    intervalMs: 3 * 60 * 1000, // 3 minutes
    rule: "Update Firebase when 200m OR 3 minutes occurs first (plus first-on and re-on cases).",
  }),

  /** §3 Storage principle */
  firebaseStorage: Object.freeze({
    keepOnlyLatestCurrentLocation: true,
    previousLocationDeletedOnNewWrite: true,
  }),

  /** §4 Ride offer fan-out (limits are Super Admin configurable) */
  rideOffer: Object.freeze({
    selectDriversWithinConfiguredDistance: true,
    orSelectConfiguredDriverCount: true,
    exampleDriverCountOptions: Object.freeze([10, 20]),
    sendOffersSimultaneously: true,
    limitsConfigurableBySuperAdmin: true,
  }),

  /** §5 Bargaining */
  bargaining: Object.freeze({
    customerMayBargainSeparatelyWithEveryOfferedDriverAtSameTime: true,
    eachDriverMaySendOwnFareOrOfferToCustomerAtSameTime: true,
  }),

  /** §6 Ride confirmation */
  rideConfirmation: Object.freeze({
    onCustomerAcceptOneDriverOffer: Object.freeze({
      rideAssignedImmediatelyToThatDriver: true,
      rideClosedAutomaticallyForAllOtherDrivers: true,
      otherDriversCannotAcceptAfterClose: true,
    }),
  }),

  /** §7 Limits */
  limits: Object.freeze({
    maxActiveRidesPerDriver: 1,
    maxConcurrentRidesPerCustomer: 4,
    customerRidesMayEachBeWithDifferentDrivers: true,
  }),

  /** §8 Offer lifetime */
  offerLifetime: Object.freeze({
    exampleTimeoutSeconds: 30,
    ifNoDriverReplyWithinConfiguredTimeout: "offer_expires_automatically",
    timeoutConfigurable: true,
  }),

  /** §9 Atomic booking */
  atomicBooking: Object.freeze({
    ifMultipleDriversAcceptNearSameTime: "server_accepts_only_first_received_acceptance",
    allOtherDriversNotifiedRideNoLongerAvailable: true,
  }),

  /** §10 Temporary offer cleanup */
  offerCleanup: Object.freeze({
    expiredOrCancelledOffers: "delete_or_archive_automatically",
    purpose: "prevent_unnecessary_data_accumulation",
  }),
});

/* -------------------------------------------------------------------------- */
/* Phase 2 — After driver–customer contact is established                     */
/* Primary = P2P; Firebase = backup                                           */
/* -------------------------------------------------------------------------- */

export const PHASE2 = Object.freeze({
  name: "phase2_post_contact_location_system",
  primaryTransport: "p2p",
  backupTransport: "firebase",

  /**
   * §1 Continuous driver location to customer while P2P is in use.
   * Continues whether customer screen is open, closed, or app is in background,
   * provided P2P system is in use.
   */
  p2pContinuousLocation: Object.freeze({
    deliverWhileCustomerScreenOpen: true,
    deliverWhileCustomerScreenClosed: true,
    deliverWhileCustomerAppBackgrounded: true,
    requiresP2pInUse: true,
  }),

  /**
   * P2P closes ONLY in these cases; in all other cases P2P stays on.
   */
  p2pCloseConditions: Object.freeze({
    driverGoesOffline: true,
    tripCompleted: true,
    tripCancelled: true,
    locationPermissionTurnedOff: true,
    otherwiseP2pRemainsOn: true,
  }),

  /**
   * POLICY A — Backup Storage (while P2P is healthy / primary).
   * Temporary Firebase storage only. Not live delivery to customer.
   * Trigger: 300m OR 1 minute (whichever first).
   */
  backupStoragePolicy: Object.freeze({
    id: "BACKUP_STORAGE_POLICY",
    activeWhen: "p2p_healthy_or_in_use",
    purpose: "temporary_firebase_backup_storage_only",
    distanceMeters: 300,
    intervalMs: 60 * 1000,
    triggerRule: "OR: 300m OR 1 minute, whichever first",
    deliverLiveToCustomer: false,
    direction: "driver_to_firebase",
  }),

  /**
   * POLICY B — Backup Live Delivery (Firebase Backup Mode only).
   * Active ONLY when P2P is unavailable / disconnected / temporarily failed.
   * Live updates to customer: 20s OR 200m (whichever first), only if customer viewing.
   * Viewing gate applies ONLY to this Firebase live path (not P2P, not driver screen).
   * Durable/permanent store: every 3rd backup live update (per approved clarification).
   * Direction always Driver → Firebase → Customer.
   */
  backupLiveDeliveryPolicy: Object.freeze({
    id: "BACKUP_LIVE_DELIVERY_POLICY",
    activeWhen: "p2p_unavailable_backup_mode",
    purpose: "live_location_to_customer_via_firebase",
    direction: "driver_to_firebase_to_customer",
    liveTriggerDistanceMeters: 200,
    liveTriggerIntervalMs: 20 * 1000,
    liveTriggerRule: "OR: 20 seconds OR 200 meters, whichever first",
    sendToCustomerOnlyIfCustomerScreenViewing: true,
    viewingConditionAppliesOnlyToFirebasePath: true,
    durableSaveEveryNthLiveUpdate: 3,
    note:
      "Every 20s-or-200m live update is for delivery; durable save is every 3rd such update. Do not conflate with backupStoragePolicy (300m/1min).",
  }),

  /** Alias kept for older draft name — prefer backupStoragePolicy */
  temporaryFirebaseCheckpoint: Object.freeze({
    supersededBy: "backupStoragePolicy",
    distanceMeters: 300,
    intervalMs: 60 * 1000,
  }),

  /** Alias kept for older draft name — prefer backupLiveDeliveryPolicy */
  firebaseBackupWhenP2pUnavailable: Object.freeze({
    supersededBy: "backupLiveDeliveryPolicy",
  }),

  firebaseBackupWhenP2pHealthy: Object.freeze({
    supersededBy: "backupStoragePolicy + backupLiveDeliveryPolicy",
    note: "Do not use this name for implementation planning.",
  }),
});

/**
 * Clarifications — ANSWERED by operator (Phase A response). Kept for audit.
 * Do NOT invent further meanings.
 */
export const SPEC_CLARIFICATIONS_REQUIRED = Object.freeze([
  Object.freeze({
    id: "P2-FIREBASE-ACTIVE-MEANING",
    phase: 2,
    status: "ANSWERED",
    answer:
      "Firebase Backup Active = P2P unavailable/disconnected/temporarily failed; system switches to Firebase Backup Mode. While P2P works normally, Firebase is NOT responsible for live delivery (backup storage only).",
  }),
  Object.freeze({
    id: "P2-THIRD-20S-DIRECTION",
    phase: 2,
    status: "ANSWERED",
    answer: "Direction is always Driver → Firebase → Customer. Firebase never sends driver location back to the driver.",
  }),
  Object.freeze({
    id: "P2-20S-VS-200M-COUPLING",
    phase: 2,
    status: "ANSWERED",
    answer: "OR condition: 20 seconds OR 200 meters — whichever first. Never AND.",
  }),
  Object.freeze({
    id: "P1-DEFAULT-NUMERIC-EXAMPLES",
    phase: 1,
    status: "ANSWERED",
    answer:
      "Spec numbers (10/20 drivers, 30s, etc.) are documentation examples only. Runtime must load Super Admin / Dispatch configuration. Do not hard-code examples.",
  }),
  Object.freeze({
    id: "P2-POLICY-A-MIRROR",
    phase: 2,
    status: "ANSWERED",
    answer:
      "Policy A: arbiter-only + do not update/mirror rides.driverLocation while P2P healthy. Customer live location only via P2P while P2P healthy.",
  }),
  Object.freeze({
    id: "P2-AVAILABLE-FLAG",
    phase: 2,
    status: "ANSWERED",
    answer:
      "Expose single boolean p2pAvailable. Backup Mode decisions depend only on this flag. Unavailable = cannot reliably deliver live location (disconnect, fail, ICE fail, heartbeat timeout, transport closed, etc.).",
  }),
  Object.freeze({
    id: "P1-SEARCH-AND-OFFER-TIMEOUT",
    phase: 1,
    status: "ANSWERED",
    answer: "Keep search timeout. Add separate per-offer timeout. Independent; do not replace one with the other.",
  }),
  Object.freeze({
    id: "ADMIN-CONFIG-KEYS",
    phase: 1,
    status: "ANSWERED",
    answer:
      "Configure via Super Admin/Dispatch when possible: idle interval/move, offer timeout, search timeout, driver count, radius, backup storage interval/distance, backup delivery interval/distance.",
  }),
  Object.freeze({
    id: "MULTI-OFFER-UI-TRACK",
    phase: 1,
    status: "ANSWERED",
    answer: "Spec defines multi-offer bargaining UI but it is OUT OF THIS IMPLEMENTATION TRACK (separate track).",
  }),
]);

export default Object.freeze({
  SPEC_META,
  PHASE1,
  PHASE2,
  SPEC_CLARIFICATIONS_REQUIRED,
});
