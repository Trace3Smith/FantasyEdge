// Shared fail-closed journal schema. Values are never included in errors.
export const validUuid = value => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export const requireAudit = value => { if (!value) throw new Error('LINEUP_ACCOUNTING_INVALID'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = (value, names) => object(value) && Object.keys(value).sort().join(',') === names.slice().sort().join(',');
const integer = value => Number.isSafeInteger(value) && value >= 0;
export const markerFor = id => 'registry:' + id;
export const rejectionStatuses = [400, 401, 403, 409, 422];
export function validateSafety(gate, registry) {
  requireAudit(fields(gate, ['schema','registryId','generation','phase']) && gate.schema === 1 &&
    validUuid(gate.registryId) && validUuid(gate.generation) && ['OPEN','CLOSED'].includes(gate.phase));
  requireAudit(fields(registry, ['schema','id','generation']) && registry.schema === 1 &&
    validUuid(registry.id) && validUuid(registry.generation) &&
    registry.id === gate.registryId && registry.generation === gate.generation);
}
export function attemptsOf(d) {
  requireAudit(Object.hasOwn(d, 'attempts'));
  if (Array.isArray(d.attempts)) return d.attempts;
  // Redis cjson encodes an empty Lua table as {}. Only the pristine BEGIN may have it.
  requireAudit(object(d.attempts) && Object.keys(d.attempts).length === 0);
  return [];
}
export function validateOperation(d) {
  requireAudit(fields(d, ['schema','id','registryId','generation','targetTag','source','status','revision','attempts','createdAt','updatedAt']) &&
    d.schema === 1 && validUuid(d.id) && validUuid(d.registryId) && validUuid(d.generation) &&
    typeof d.targetTag === 'string' && /^[a-f0-9]{64}$/.test(d.targetTag) &&
    typeof d.source === 'string' && /^[a-f0-9]{40}$/.test(d.source) &&
    ['ACTIVE','BLOCKED','COMPLETE'].includes(d.status) && integer(d.revision) &&
    integer(d.createdAt) && integer(d.updatedAt));
  const attempts = attemptsOf(d);
  requireAudit(attempts.length <= 6 && new Set(attempts.map(a => a?.id)).size === attempts.length);
  if (!attempts.length) {
    requireAudit(d.status === 'ACTIVE' && d.revision === 0);
    return attempts;
  }
  let transitions = 0;
  for (const [i, a] of attempts.entries()) {
    requireAudit(fields(a, ['id','operationId','ordinal','state','httpStatus','events']) && validUuid(a.id) &&
      a.operationId === d.id && a.ordinal === i + 1 && Array.isArray(a.events));
    requireAudit(a.events.every(e => fields(e, ['state','at']) && integer(e.at)));
    const chain = a.events.map(e => e.state).join(',');
    requireAudit(['PREPARED','PREPARED,POSSIBLY_SENT','PREPARED,POSSIBLY_SENT,ACKNOWLEDGED',
      'PREPARED,POSSIBLY_SENT,REJECTED','PREPARED,POSSIBLY_SENT,UNKNOWN'].includes(chain) && a.events.at(-1).state === a.state);
    if (['PREPARED','POSSIBLY_SENT'].includes(a.state)) requireAudit(a.httpStatus === 0);
    if (a.state === 'ACKNOWLEDGED') requireAudit(Number.isInteger(a.httpStatus) && a.httpStatus >= 200 && a.httpStatus < 300);
    if (a.state === 'REJECTED') requireAudit(rejectionStatuses.includes(a.httpStatus));
    if (a.state === 'UNKNOWN') requireAudit(a.httpStatus === 0 || Number.isInteger(a.httpStatus) &&
      a.httpStatus >= 100 && a.httpStatus <= 599 && !(a.httpStatus >= 200 && a.httpStatus < 300) && !rejectionStatuses.includes(a.httpStatus));
    // The sole existing retry path is an explicitly rejected HTTP 409.
    if (i < attempts.length - 1) requireAudit(a.state === 'REJECTED' && a.httpStatus === 409);
    transitions += a.events.length;
  }
  requireAudit(d.revision === transitions + (d.status === 'ACTIVE' ? 0 : 1));
  const last = attempts.at(-1).state;
  if (d.status === 'COMPLETE') requireAudit(['ACKNOWLEDGED','REJECTED'].includes(last));
  if (d.status === 'BLOCKED') requireAudit(['POSSIBLY_SENT','UNKNOWN'].includes(last));
  return attempts;
}
