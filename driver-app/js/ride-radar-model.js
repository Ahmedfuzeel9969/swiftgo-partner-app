/** Shared Ride Radar types (JSDoc). */

/**
 * @typedef {Object} RadarRide
 * @property {string} id
 * @property {"ride_requests"|"rides"} sourceCollection
 * @property {"pending"} status
 * @property {string} vehicleType
 * @property {string} vehicleTypeKey
 * @property {string} vehicleIcon
 * @property {{ lat: number|null, lng: number|null, address: string }} pickup
 * @property {{ lat: number|null, lng: number|null, address: string }} dropoff
 * @property {number|null} tripKm
 * @property {number} estimatedFare
 * @property {string} riderUserId
 * @property {number|null} riderRating
 * @property {number} createdAtMs
 */

export {};
