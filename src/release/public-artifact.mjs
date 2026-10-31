/** @typedef {{version:string,filename:string,bytes:number,sha256:string,notarization:'Accepted',stapled:true,gatekeeperAccepted:true,sourceCommit?:string}} PublicArtifact */

/** Public download metadata cannot claim an unsigned, unstapled or mismatched artifact.
 * @param {unknown} input @returns {PublicArtifact} */
export function validatePublicArtifact(input) {
  const value = /** @type {Partial<PublicArtifact>|null} */ (input);
  if (!value || !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(value.version ?? '') || value.filename !== `CodeLight-${value.version}-macos-arm64.zip`
    || !Number.isSafeInteger(value.bytes) || /** @type {number} */ (value.bytes) <= 0 || !/^[a-f0-9]{64}$/u.test(value.sha256 ?? '')
    || value.notarization !== 'Accepted' || value.stapled !== true || value.gatekeeperAccepted !== true
    || value.sourceCommit !== undefined && !/^[a-f0-9]{40}$/u.test(value.sourceCommit)
    || Object.keys(value).some(key => !['version', 'filename', 'bytes', 'sha256', 'notarization', 'stapled', 'gatekeeperAccepted', 'sourceCommit'].includes(key))) throw Error('Invalid verified public artifact.');
  return /** @type {PublicArtifact} */ ({ ...value });
}
