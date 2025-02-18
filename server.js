const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const app = express();
app.use(express.json({ limit: '50mb' }));

// Configuration
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const ALLOWED_DIRS = ['/opt/latex-service/latexfiles']; // Updated path

// Security: Validate file paths
function isPathAllowed(filePath) {
    const normalizedPath = path.normalize(filePath);
    return ALLOWED_DIRS.some(dir => normalizedPath.startsWith(dir));
}

app.post('/compile', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const { content, filename } = req.body;
        
        if (!filename || typeof filename !== 'string') {
            return res.status(400).json({ error: 'Invalid filename' });
        }
        
        if (!content || typeof content !== 'string') {
            return res.status(400).json({ error: 'Invalid content' });
        }

        const absolutePath = path.resolve('/opt/latex-service', filename);
        if (!isPathAllowed(absolutePath)) {
            return res.status(403).json({ 
                error: 'Access to this directory is not allowed',
                path: absolutePath
            });
        }
        
        const dirPath = path.dirname(absolutePath);
        const baseFilename = path.basename(filename);
        
        await fs.mkdir(dirPath, { recursive: true });
        await fs.writeFile(absolutePath, content);
        
        // Run pdflatex twice to resolve references
        for (let i = 0; i < 2; i++) {
            const { stdout, stderr } = await execPromise(
                `cd "${dirPath}" && pdflatex -interaction=nonstopmode "${baseFilename}"`,
                { maxBuffer: 1024 * 1024 * 10 }
            );
            console.log(`Compilation ${i + 1} output:`, stdout);
            if (stderr) console.error(`Compilation ${i + 1} errors:`, stderr);
        }
        
        const pdfFilename = baseFilename.replace('.tex', '.pdf');
        const pdfPath = path.join(dirPath, pdfFilename);
        const pdfContent = await fs.readFile(pdfPath);
        
        // Clean up temporary files
        const cleanupFiles = [
            baseFilename,
            pdfFilename,
            baseFilename.replace('.tex', '.aux'),
            baseFilename.replace('.tex', '.log'),
            baseFilename.replace('.tex', '.out')
        ].map(file => path.join(dirPath, file));
        
        await Promise.all(
            cleanupFiles.map(file => 
                fs.unlink(file).catch(err => 
                    console.error(`Failed to delete ${file}:`, err)
                )
            )
        );
        
        res.set('Content-Type', 'application/pdf');
        res.send(pdfContent);
        
    } catch (error) {
        console.error('Compilation error:', error);
        res.status(500).json({ 
            error: 'PDF compilation failed',
            details: error.message,
            command: error.cmd
        });
    }
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.listen(PORT, () => {
    console.log(`LaTeX compilation server running on port ${PORT}`);
});
