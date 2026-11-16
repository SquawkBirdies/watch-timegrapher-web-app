// Handing a file to the user: the share sheet where the browser has one (on the iPhone it
// offers Save to Files), otherwise an ordinary download.

/**
 * @param {Blob} blob
 * @param {string} name file name
 * @returns {Promise<'shared'|'downloaded'|'cancelled'>}
 */
export async function offerFile(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
      return 'shared';
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return 'cancelled';
    // Sharing failed for another reason: fall back to a download.
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return 'downloaded';
}

/**
 * A file name with the local date and time, such as timegrapher-live-20261116-143005.wav.
 * @param {string} prefix
 * @param {string} extension without the dot
 * @param {Date} [date]
 */
export function stampedName(prefix, extension, date = new Date()) {
  const pad = (/** @type {number} */ v) => String(v).padStart(2, '0');
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${prefix}-${day}-${time}.${extension}`;
}
