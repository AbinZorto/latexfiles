require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');

const app = express();
app.use(cors());
app.use(express.json());

// API Key Authentication
const authenticateApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.LATEX_SERVICE_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

app.use(authenticateApiKey);

app.post('/compile', async (req, res) => {
  let uniqueTmpDir;
  
  try {
    const { content, templateId, paperTitle } = req.body;

    uniqueTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'latex-'));
    const texFilePath = path.join(uniqueTmpDir, 'document.tex');
    const pdfFilePath = path.join(uniqueTmpDir, 'document.pdf');

    await fs.writeFile(texFilePath, content, 'utf-8');

    const pdflatex = spawn('pdflatex', [
      '-interaction=nonstopmode',
      'document.tex'
    ], {
      cwd: uniqueTmpDir
    });

    const exitCode = await new Promise((resolve, reject) => {
      pdflatex.on('close', resolve);
      pdflatex.on('error', reject);
    });

    if (exitCode !== 0) {
      throw new Error('PDF compilation failed');
    }

    const pdfBuffer = await fs.readFile(pdfFilePath);
    
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment'
    });
    res.send(pdfBuffer);

  } catch (error) {
    console.error('Compilation error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (uniqueTmpDir) {
      await fs.remove(uniqueTmpDir).catch(console.error);
    }
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`LaTeX service running on port ${PORT}`));
