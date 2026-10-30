import { expect, test } from 'vitest';
import { rasterData } from './visual-images.js';
test('rejects HTML/SVG placeholders and accepts only native raster signatures', () => {
  expect(() => rasterData(Buffer.from('<html>fake concept</html>'))).toThrow(/not PNG/);
  expect(() => rasterData(Buffer.from('<svg></svg>'))).toThrow();
  expect(rasterData(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])).mimeType).toBe('image/png');
});
