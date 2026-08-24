import { GoogleGenAI } from '@google/genai';
import fs from 'node:fs';

const imagePath = process.env.TEST_IMAGE_PATH;
if (!imagePath) {
  throw new Error('Set TEST_IMAGE_PATH to an image file before running this script.');
}
const imageBuffer = fs.readFileSync(imagePath);
const base64Data = imageBuffer.toString('base64');

const apiKey = process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey });

async function testPrompt(name, promptText) {
  console.log(`
=== Testing: ${name} ===`);
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        { inlineData: { mimeType: 'image/png', data: base64Data } },
        promptText
      ],
      config: {
        responseMimeType: 'application/json',
      }
    });
    console.log(response.text);
  } catch (err) {
    console.error(err);
  }
}

async function run() {
  await testPrompt('Current Prompt', `You are an expert computer vision model specializing in image segmentation and background removal.
Analyze all main foreground subjects in this image (e.g. people, pets, products, objects, items).
Extract the precise boundary contour outlining all main foreground subjects, excluding only background elements.
Return a JSON object with the following schema:
{
  "label": "short description of all main foreground subjects",
  "svgPath": "smooth closed SVG path 'd' attribute string outlining all main subjects tightly in normalized coordinates (viewBox 0 0 1000 1000). Start with 'M', use bezier curves (C, S, Q) and line segments (L), and close every subpath with 'Z'. Coordinates must span 0 to 1000 where (0,0) is top-left and (1000,1000) is bottom-right.",
  "boundingBox": [ymin, xmin, ymax, xmax]
}`);

  await testPrompt('Polygon Points Prompt', `Detect the main foreground subject(s) in the image.
Provide a fine-grained 2D polygon segmentation mask for the foreground subject(s).
Return JSON:
{
  "label": "description",
  "boundingBox": [ymin, xmin, ymax, xmax],
  "polygon": [[y, x], [y, x], ...]
}
Where polygon contains at least 30-100 vertex points outlining the outer boundary of the foreground subject(s) in normalized coordinates 0-1000 (y from 0 to 1000 top to bottom, x from 0 to 1000 left to right).`);
}

run();
