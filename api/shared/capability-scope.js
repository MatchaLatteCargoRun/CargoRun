'use strict';

// Only this reviewed control-plane allowlist may flow from a global role
// assignment. Every other capability requires an explicit station grant.
const CONTROL_PLANE_CAPABILITIES = Object.freeze([
  'PUBLISH_MESSAGES', 'EDIT_AIRLINE_RULES', 'EDIT_SLA_RULES',
  'EDIT_SHC_RULES', 'MANAGE_USERS', 'VIEW_ADMIN_AUDIT'
]);
const controlPlane = new Set(CONTROL_PLANE_CAPABILITIES);
const isControlPlaneCapability = value => controlPlane.has(String(value || '').trim().toUpperCase());
// Fixed source literals only; never interpolate request/configuration values.
const CONTROL_PLANE_CAPABILITY_SQL = CONTROL_PLANE_CAPABILITIES.map(code => `'${code}'`).join(',');

module.exports = { CONTROL_PLANE_CAPABILITIES, CONTROL_PLANE_CAPABILITY_SQL, isControlPlaneCapability };
