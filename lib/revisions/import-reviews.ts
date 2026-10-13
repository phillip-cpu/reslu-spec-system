/** Reviewed import fingerprints only. Never put archived financial rows or credentials here.
 * A new review also needs the matching private database review record; the API cannot
 * approve an archive, enable a gate, or choose an audit identity.
 */
export interface ImportReview {
  projectId: string; label: string; archiveSha256: string; archiveBytes: number;
  frozenHash: string; snapshotHash: string; manifestHash: string;
  pdf: { storage_path: string; sha256: string; bytes: number };
  totalIncGst: number;
}
export const importReviews: Readonly<Record<string, ImportReview>> = {
  'c879800a-431f-4170-a793-c6bc5173ddc7': {
    projectId: 'c879800a-431f-4170-a793-c6bc5173ddc7', label: 'V2',
    archiveSha256: '6762881cec9c0c2e75ccb3de74ae3bb96385f065b0eccb71b1744a0ab4cb22ee', archiveBytes: 806488,
    frozenHash: 'affa428107b007c4ed60100f74dc87451831f2da0db9d904c052a113d60a89a3',
    snapshotHash: '1a5dfaadb0789b4aef6165f0df6bf3cf3e0d0c98f02253695dcf0fafcd270e69',
    manifestHash: 'aabb74c04ed04ac754c569b8a2c6d2e878fac41ee75b32d00628d53d4506ea09',
    pdf: {storage_path:'projects/c879800a-431f-4170-a793-c6bc5173ddc7/files/frozen-v2-df04737ccec88909.pdf', sha256:'df04737ccec88909854be09808a52f74e25884c11498c62d25c77f504db3c4cb',bytes:369590},
    totalIncGst:496863.99,
  },
};
