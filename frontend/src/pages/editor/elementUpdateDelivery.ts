/**
 * Client-side ceilings for live element-update delivery.
 *
 * Keep these local to the browser bundle, but coupled to the server's
 * production ceilings through elementUpdateLimitContract.test.ts.
 */
export const LIVE_UPDATE_MAX_BYTES = 11 * 1024 * 1024;
export const LIVE_UPDATE_MAX_FILE_DATA_URL_LENGTH = 10 * 1024 * 1024;
