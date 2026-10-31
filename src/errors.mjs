export class BridgeError extends Error {
  /** @param {string} code @param {string} message @param {number} [status] */
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** @param {unknown} error */
export function publicError(error) {
  return error instanceof BridgeError
    ? { error: error.code, message: error.message, status: error.status }
    : { error: 'internal-error', message: '操作失败，请重试或查看本机服务状态。', status: 500 };
}
