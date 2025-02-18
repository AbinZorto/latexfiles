require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs-extra');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

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
    try {
        const { content, filename } = req.body;
        
        if (!filename || typeof filename !== 'string') {
            return res.status(400).json({ error: 'Invalid filename' });
        }
        
        if (!content || typeof content !== 'string') {
            return res.status(400).json({ error: 'Invalid content' });
        }

        // Resolve the full path within /opt/latex-service
        const absolutePath = path.resolve('/opt/latex-service', filename);
        const dirPath = path.dirname(absolutePath);
        const baseFilename = path.basename(filename);

        // Create directory if it doesn't exist
        await fs.mkdirp(dirPath);
        
        // Write the LaTeX content
        await fs.writeFile(absolutePath, content, 'utf-8');

        // Run pdflatex in the correct directory
        const pdflatex = spawn('pdflatex', [
            '-interaction=nonstopmode',
            baseFilename
        ], {
            cwd: dirPath
        });

        // Collect output for error reporting
        let output = '';
        pdflatex.stdout.on('data', (data) => {
            output += data.toString();
        });
        pdflatex.stderr.on('data', (data) => {
            output += data.toString();
        });

        const exitCode = await new Promise((resolve, reject) => {
            pdflatex.on('close', resolve);
            pdflatex.on('error', reject);
        });

        if (exitCode !== 0) {
            throw new Error(`PDF compilation failed:\n${output}`);
        }

        // Read the generated PDF
        const pdfPath = path.join(dirPath, baseFilename.replace('.tex', '.pdf'));
        const pdfBuffer = await fs.readFile(pdfPath);

        // Clean up files
        const cleanupFiles = [
            baseFilename,
            baseFilename.replace('.tex', '.pdf'),
            baseFilename.replace('.tex', '.aux'),
            baseFilename.replace('.tex', '.log'),
            baseFilename.replace('.tex', '.out')
        ].map(file => path.join(dirPath, file));

        await Promise.all(
            cleanupFiles.map(file => 
                fs.remove(file).catch(err => 
                    console.error(`Failed to delete ${file}:`, err)
                )
            )
        );

        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'attachment'
        });
        res.send(pdfBuffer);

    } catch (error) {
        console.error('Compilation error:', error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`LaTeX service running on port ${PORT}`));
