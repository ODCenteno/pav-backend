import { describe, it, expect, vi } from 'vitest';
import spanishErrors from '../src/extensions/upload/utils/spanish-errors.js';
import uploadExtension from '../src/extensions/upload/strapi-server.js';

const { translateErrorMessage, translateUploadError } = spanishErrors;

describe('spanish-errors message translation', () => {
  it('translates MIME type rejection messages', () => {
    expect(translateErrorMessage("File type 'application/zip' is not allowed")).toBe(
      "El tipo de archivo 'application/zip' no está permitido"
    );
  });

  it('translates the generic MIME message', () => {
    expect(translateErrorMessage('MIME type is not allowed')).toBe('El tipo MIME no está permitido');
  });

  it('translates the security-verification message', () => {
    expect(translateErrorMessage('Cannot verify file type for security reasons')).toBe(
      'No se puede verificar el tipo de archivo por razones de seguridad'
    );
  });

  it('translates size-limit messages', () => {
    expect(translateErrorMessage('video.mp4 exceeds size limit of 100 MB.')).toBe(
      'video.mp4 excede el límite de tamaño de 100 MB.'
    );
  });

  it('passes unrelated messages through unchanged', () => {
    expect(translateErrorMessage('Connection reset by peer')).toBe('Connection reset by peer');
  });

  it('returns non-string / empty messages untouched', () => {
    expect(translateErrorMessage(undefined)).toBeUndefined();
    expect(translateErrorMessage(null)).toBeNull();
    expect(translateErrorMessage('')).toBe('');
  });

  it('translateUploadError mutates the message in place and returns the same error', () => {
    const error = new Error("File type 'image/heic' is not allowed");
    const returned = translateUploadError(error);
    expect(returned).toBe(error);
    expect(error.message).toBe("El tipo de archivo 'image/heic' no está permitido");
  });

  it('leaves errors with untranslatable messages untouched', () => {
    const error = new Error('ECONNREFUSED');
    const returned = translateUploadError(error);
    expect(returned).toBe(error);
    expect(error.message).toBe('ECONNREFUSED');
  });
});

describe('upload extension wrapping (strapi-server)', () => {
  function makePlugin() {
    return {
      controllers: {
        'admin-upload': {
          upload: vi.fn(async () => {
            throw new Error("File type 'application/x-msdownload' is not allowed");
          }),
          uploadFiles: vi.fn(async (ctx) => ({ ok: true, via: 'uploadFiles', ctx })),
          replaceFile: vi.fn(async () => {
            throw new Error('presentacion.pdf exceeds size limit of 2 MB.');
          }),
          updateFileInfo: vi.fn(async () => ({ via: 'untouched' })),
        },
        'content-api': ({ strapi }) => ({
          upload: vi.fn(async () => {
            throw new Error('MIME type is not allowed');
          }),
          replaceFile: vi.fn(async () => {
            throw new Error('Read timeout while streaming');
          }),
        }),
      },
    };
  }

  it('wraps admin-upload controllers so MIME errors surface in Spanish', async () => {
    const plugin = makePlugin();
    uploadExtension(plugin);

    await expect(plugin.controllers['admin-upload'].upload({})).rejects.toThrow(
      "El tipo de archivo 'application/x-msdownload' no está permitido"
    );
  });

  it('translates size errors on wrapped methods', async () => {
    const plugin = makePlugin();
    uploadExtension(plugin);

    await expect(plugin.controllers['admin-upload'].replaceFile({})).rejects.toThrow(
      'presentacion.pdf excede el límite de tamaño de 2 MB.'
    );
  });

  it('passes unrelated errors through unchanged', async () => {
    const plugin = makePlugin();
    uploadExtension(plugin);

    await expect(plugin.controllers['content-api']({ strapi: {} }).replaceFile({})).rejects.toThrow(
      'Read timeout while streaming'
    );
  });

  it('passes successful calls through unchanged', async () => {
    const plugin = makePlugin();
    uploadExtension(plugin);

    const ctx = { files: ['a.png'] };
    const result = await plugin.controllers['admin-upload'].uploadFiles(ctx);
    expect(result).toEqual({ ok: true, via: 'uploadFiles', ctx });
  });

  it('wraps the content-api factory result as well', async () => {
    const plugin = makePlugin();
    uploadExtension(plugin);

    const instance = plugin.controllers['content-api']({ strapi: {} });
    await expect(instance.upload({})).rejects.toThrow('El tipo MIME no está permitido');
  });

  it('does not wrap methods outside the upload/uploadFiles/replaceFile list', async () => {
    const plugin = makePlugin();
    const before = plugin.controllers['admin-upload'].updateFileInfo;
    uploadExtension(plugin);

    expect(plugin.controllers['admin-upload'].updateFileInfo).toBe(before);
    await expect(plugin.controllers['admin-upload'].updateFileInfo()).resolves.toEqual({ via: 'untouched' });
  });

  it('returns the plugin object itself', () => {
    const plugin = makePlugin();
    expect(uploadExtension(plugin)).toBe(plugin);
  });
});
