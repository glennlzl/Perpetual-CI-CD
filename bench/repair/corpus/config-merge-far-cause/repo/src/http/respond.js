/** Router responses: a status and a JSON body. */
export const ok = body => ({ status: 200, body });
export const created = body => ({ status: 201, body });
export const refused = (status, message) => ({ status, body: { error: message } });
