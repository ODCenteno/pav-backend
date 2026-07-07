const MIME_PATTERN = /^File type '(.+)' is not allowed$/;
const SIZE_PATTERN = /^(.+) exceeds size limit of (.+)\.$/;

function translateMimeError(mime) {
  return `El tipo de archivo '${mime}' no está permitido`;
}

function translateSizeError(filename, size) {
  return `${filename} excede el límite de tamaño de ${size}.`;
}

function translateErrorMessage(message) {
  if (!message || typeof message !== 'string') return message;

  const mimeMatch = message.match(MIME_PATTERN);
  if (mimeMatch) {
    return translateMimeError(mimeMatch[1]);
  }

  if (message === 'MIME type is not allowed') {
    return 'El tipo MIME no está permitido';
  }

  if (message === 'Cannot verify file type for security reasons') {
    return 'No se puede verificar el tipo de archivo por razones de seguridad';
  }

  const sizeMatch = message.match(SIZE_PATTERN);
  if (sizeMatch) {
    return translateSizeError(sizeMatch[1], sizeMatch[2]);
  }

  return message;
}

function translateUploadError(error) {
  if (error && typeof error.message === 'string') {
    const translated = translateErrorMessage(error.message);
    if (translated !== error.message) {
      error.message = translated;
    }
  }
  return error;
}

module.exports = { translateErrorMessage, translateUploadError };
