/** Saves a file on the user's device. Generated in memory: nothing is uploaded. */
export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  // Revoke later: some browsers (Safari) cancel the download if the URL is revoked immediately
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
