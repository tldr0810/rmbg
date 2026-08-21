/**
 * A real 64x64 RGBA PNG: an opaque circle on a transparent field, i.e. the shape a
 * successful background removal produces. Only 223 bytes — flat colour compresses hard,
 * which is exactly why the cutout guard measures dimensions rather than byte length.
 */
export const CUTOUT_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAApklEQVR42u3aUQ2AMAxF0cmZfz14AQ0ktGvpuQkC3vlj21qSJEmK7dr7fvuNHP0LjC+Ht4KIHF4eInN8OYQT48sgnBx/HKHC+GMIlcanI1Qcn4ZQeXwKwmiADuNDEUYDdBofggBgMkDH8Z8iAAAAAAAAAAAAAAAAwA+R32EAjsUcijoadzEyGGD83aDbYe8DvBDxRsgrMe8EvRRNh1jdGzlakiSV7gFzyidhKkfs5AAAAABJRU5ErkJggg==';

/**
 * The 1x1 transparent PNG a background-removal agent hands back when it never actually
 * received the image. Captured from a live agent turn against the deployed Worker.
 */
export const PLACEHOLDER_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
