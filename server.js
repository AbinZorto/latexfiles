require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const fs = require("fs-extra");
const path = require("path");
const axios = require("axios");

const app = express();
app.use(
  cors({
    exposedHeaders: ["X-LaTeX-Output"],
  })
);
app.use(express.json({ limit: "50mb" }));

// API Key Authentication
const authenticateApiKey = (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== process.env.LATEX_SERVICE_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};

app.use(authenticateApiKey);

// Add this helper function to format LaTeX output
function formatLatexOutput(stdout) {
  // Split into lines and filter out empty ones
  const lines = stdout.split("\n").filter((line) => line.trim());

  // Group related messages
  const formatted = lines
    .reduce((acc, line) => {
      // Remove common TeX Live paths to reduce noise
      line = line.replace(
        /\/usr\/local\/texlive\/\d+\/texmf-dist\/tex\/[^\s]+\//,
        ""
      );

      // Skip certain verbose lines
      if (
        line.includes("texmf-dist") ||
        line.includes("geometry driver") ||
        line.includes("restricted \\write18 enabled")
      ) {
        return acc;
      }

      // Highlight important messages
      if (line.startsWith("!")) {
        return acc + "\nError: " + line;
      }
      if (line.includes("Warning")) {
        return acc + "\nWarning: " + line;
      }
      if (line.includes("Output written on")) {
        return acc + "\nOutput: " + line;
      }

      return acc + "\n" + line;
    }, "")
    .trim();

  return formatted;
}

/**
 * Downloads or extracts images for LaTeX compilation
 * @param {Object} imageReferences - Map of image references with URLs and file info
 * @param {string} targetDir - Directory to save downloaded images
 * @returns {Promise<Object>} - Results of image processing
 */
async function downloadImages(imageReferences, targetDir) {
  if (!imageReferences || Object.keys(imageReferences).length === 0) {
    console.log("No image references to download");
    return { successful: 0, failed: 0 };
  }

  console.log(
    `Processing ${Object.keys(imageReferences).length} images for ${targetDir}`
  );

  // Create images directory
  const imagesDir = path.join(targetDir, "images");
  await fs.mkdirp(imagesDir);
  console.log(`Created images directory at: ${imagesDir}`);

  // Log all image references for debugging
  console.log(
    "Image references to process:",
    Object.entries(imageReferences)
      .map(([id, img]) => `${id} -> ${img.filename || "unnamed"}`)
      .join(", ")
  );

  // Process each image (either from URL or base64)
  const processPromises = Object.entries(imageReferences).map(
    async ([key, image]) => {
      const {
        id,
        url,
        filename,
        base64Data,
        contentType,
        originalSize,
        compressedSize,
      } = image;

      // Ensure we have a valid filename that matches the key exactly
      const safeKey = key.replace(/[^a-zA-Z0-9]/g, "_");
      const outputFilename = filename || `${safeKey}.jpg`;
      const outputPath = path.join(imagesDir, outputFilename);

      console.log(
        `Processing image ${id} (key: ${key}) with target path: ${outputPath}`
      );

      try {
        // If we have base64 data, use that instead of downloading
        if (base64Data) {
          console.log(
            `Using provided base64 data for image ${id} (${base64Data.length} bytes)`
          );

          try {
            // Decode base64 to buffer
            const imageBuffer = Buffer.from(base64Data, "base64");

            // Check if the buffer is valid
            if (imageBuffer.length === 0) {
              throw new Error("Empty buffer after base64 decoding");
            }

            // Write to file
            await fs.writeFile(outputPath, imageBuffer);
            console.log(
              `Successfully saved base64 image to ${outputPath} (${imageBuffer.length} bytes)`
            );

            // Verify the file was written
            const fileExists = await fs.pathExists(outputPath);
            const fileSize = fileExists ? (await fs.stat(outputPath)).size : 0;
            console.log(
              `File verification: exists=${fileExists}, size=${fileSize} bytes`
            );

            return {
              id,
              key,
              success: true,
              path: outputPath,
              size: imageBuffer.length,
            };
          } catch (decodeError) {
            console.error(
              `Error decoding base64 data for image ${id}:`,
              decodeError
            );
            throw new Error(
              `Failed to decode base64 data: ${decodeError.message}`
            );
          }
        }

        // Otherwise try URL download as before
        console.log(`Downloading image ${id} from URL: ${url}`);
        console.log(`Target path: ${outputPath}`);

        const startTime = Date.now();
        const response = await axios({
          method: "GET",
          url: url,
          responseType: "arraybuffer",
          timeout: 30000, // 30 second timeout
          maxContentLength: 10 * 1024 * 1024, // 10MB limit
          validateStatus: false, // Don't throw on any status code
        });
        const duration = Date.now() - startTime;

        // Log the response details
        console.log(`Response received for image ${id} after ${duration}ms:`);
        console.log(`  Status: ${response.status} ${response.statusText}`);
        console.log(`  Content Type: ${response.headers["content-type"]}`);
        console.log(`  Content Length: ${response.data?.length || 0} bytes`);

        // Check for valid image response
        if (response.status !== 200) {
          throw new Error(
            `HTTP status ${response.status}: ${response.statusText}`
          );
        }

        // Check if we actually got image data
        const responseContentType = response.headers["content-type"];
        if (!responseContentType || !responseContentType.startsWith("image/")) {
          // If not an image, write the response to a log file for inspection
          const responseText = response.data.toString().substring(0, 1000); // First 1000 chars
          console.error(
            `Non-image content type received: ${responseContentType}`
          );
          console.error(`Response preview: ${responseText}`);

          const logFilePath = path.join(targetDir, `image_${id}_error.log`);
          await fs.writeFile(
            logFilePath,
            `URL: ${url}\nStatus: ${response.status}\nContent-Type: ${responseContentType}\n\nResponse:\n${responseText}`
          );
          console.log(`Wrote error details to ${logFilePath}`);

          throw new Error(
            `Received non-image content type: ${responseContentType}`
          );
        }

        // Write the image data to file
        await fs.writeFile(outputPath, response.data);
        console.log(
          `Successfully saved image ${id} to ${outputPath} (${response.data.length} bytes)`
        );

        return {
          id,
          key,
          success: true,
          path: outputPath,
          size: response.data.length,
        };
      } catch (error) {
        console.error(`Failed to process image ${id} (key: ${key}):`);
        console.error(`  Error: ${error.message}`);

        if (error.response) {
          console.error(`  Status: ${error.response.status}`);
          console.error(`  Headers: ${JSON.stringify(error.response.headers)}`);
          // Log the first part of the response if it's text
          if (error.response.data) {
            try {
              const preview = Buffer.isBuffer(error.response.data)
                ? error.response.data.toString("utf8").substring(0, 200)
                : JSON.stringify(error.response.data).substring(0, 200);
              console.error(`  Response preview: ${preview}...`);
            } catch (e) {
              console.error("  Cannot preview response data");
            }
          }
        } else if (error.request) {
          console.error("  No response received from server");
        }

        return { id, key, success: false, error: error.message };
      }
    }
  );

  // Wait for all downloads to complete
  const results = await Promise.allSettled(processPromises);

  // List all files in the images directory to verify
  try {
    const imageFiles = await fs.readdir(imagesDir);
    console.log(`Images directory now contains: ${imageFiles.join(", ")}`);
  } catch (err) {
    console.error(`Error listing images directory: ${err.message}`);
  }

  // Summarize results
  const successful = results.filter(
    (r) => r.status === "fulfilled" && r.value.success
  ).length;
  const failed = results.filter(
    (r) =>
      r.status === "rejected" || (r.status === "fulfilled" && !r.value.success)
  ).length;

  console.log(
    `Image downloads completed: ${successful} successful, ${failed} failed`
  );
  return { successful, failed };
}

app.post("/compile", async (req, res) => {
  console.log("\n===== NEW COMPILATION REQUEST =====");
  console.log("Request received at:", new Date().toISOString());
  console.log("Request IP:", req.ip);
  console.log("Request headers:", JSON.stringify(req.headers, null, 2));

  // Initialize all variables at the top level
  let stdout1 = "",
    stdout2 = "",
    stdout3 = "";
  let errors = [],
    warnings = false;

  try {
    const { content, filename, bibliography, imageReferences } = req.body;

    // Log request details
    console.log("Compile request details:");
    console.log(`  Filename: ${filename}`);
    console.log(`  Content length: ${content?.length || 0} characters`);
    console.log(`  Has bibliography: ${!!bibliography}`);
    console.log(
      `  Image references: ${imageReferences ? Object.keys(imageReferences).length : 0}`
    );

    // Print the first 500 characters of the content for debugging
    if (content) {
      console.log(`  Content preview: ${content.substring(0, 500)}...`);
    }

    // Log image reference keys
    if (imageReferences) {
      console.log(
        `  Image reference keys: ${Object.keys(imageReferences).join(", ")}`
      );
    }

    // Input validation checks
    if (!content || !filename) {
      console.error("Missing required fields:", {
        content: !!content,
        filename: !!filename,
      });
      return res.status(400).json({ error: "Missing required fields" });
    }

    const absolutePath = path.resolve("/opt/latexfiles", filename);
    const dirPath = path.dirname(absolutePath);
    const baseFilename = path.basename(filename);

    console.log("File paths:");
    console.log(`  Absolute path: ${absolutePath}`);
    console.log(`  Directory path: ${dirPath}`);
    console.log(`  Base filename: ${baseFilename}`);

    try {
      // Create the directory structure
      console.log(`Creating directory: ${dirPath}`);
      await fs.mkdirp(dirPath);

      // Write the LaTeX content to file
      console.log(`Writing LaTeX file to: ${absolutePath}`);
      await fs.writeFile(absolutePath, content, "utf-8");
      console.log("LaTeX file written successfully");

      // Check if the file was actually written
      const stats = await fs.stat(absolutePath);
      console.log(`LaTeX file stats: ${JSON.stringify(stats)}`);

      // List directory contents for verification
      const dirContents = await fs.readdir(dirPath);
      console.log(
        `Directory contents after writing LaTeX: ${dirContents.join(", ")}`
      );

      // Handle bibliography if present
      if (bibliography?.content) {
        const bibPath = path.join(dirPath, "references.bib");
        console.log(`Writing bibliography to: ${bibPath}`);
        await fs.writeFile(bibPath, bibliography.content, "utf-8");
        console.log("Bibliography file written successfully");
      }

      // Download images if present
      if (imageReferences && Object.keys(imageReferences).length > 0) {
        console.log(
          `Processing ${Object.keys(imageReferences).length} image references`
        );
        const downloadResult = await downloadImages(imageReferences, dirPath);
        console.log(
          `Image download summary: ${JSON.stringify(downloadResult)}`
        );

        // Check images directory afterwards
        const imagesDir = path.join(dirPath, "images");
        if (await fs.pathExists(imagesDir)) {
          const imageFiles = await fs.readdir(imagesDir);
          console.log(`Images directory contains: ${imageFiles.join(", ")}`);
        } else {
          console.warn(`Images directory not created at ${imagesDir}`);
        }
      }

      const lualatexOptions = [
        "-file-line-error",
        "-interaction=nonstopmode",
        baseFilename,
      ];
      console.log("lualatex options:", lualatexOptions);

      // First lualatex run
      console.log("Starting first lualatex run...");
      const requestTimeout = 300000; // 5 minutes in milliseconds

      // First lualatex run
      console.log("Starting first lualatex run...");
      const lualatex1 = spawn("lualatex", lualatexOptions, {
        cwd: dirPath,
        timeout: requestTimeout,
      });
      let stderr1 = "";

      lualatex1.stdout.on("data", (data) => {
        stdout1 += data.toString();
      });

      lualatex1.on("error", (err) => {
        if (err.code === "ETIMEDOUT") {
          console.error(
            `lualatex1 process timed out after ${requestTimeout / 1000} seconds.`
          );
          errors.push(
            `Compilation timed out: lualatex1 process exceeded ${requestTimeout / 1000} seconds.`
          );
        } else {
          console.error(`lualatex1 process error: ${err.message}`);
          errors.push(`lualatex1 process error: ${err.message}`);
        }
      });

      lualatex1.stderr.on("data", (data) => {
        stderr1 += data.toString();
        console.error("lualatex1 stderr:", data.toString());
      });

      await new Promise((resolve) =>
        lualatex1.on("close", (code) => {
          console.log("First lualatex run completed with code:", code);
          resolve();
        })
      );

      // Run bibtex if bibliography exists
      let bibtexOutput = "";
      if (bibliography?.content) {
        console.log("Starting bibtex run...");
        const bibtex = spawn("bibtex", [baseFilename.replace(".tex", "")], {
          cwd: dirPath,
        });

        bibtex.stdout.on("data", (data) => {
          bibtexOutput += data.toString();
        });

        bibtex.stderr.on("data", (data) => {
          console.error("bibtex stderr:", data.toString());
        });

        await new Promise((resolve) =>
          bibtex.on("close", (code) => {
            console.log("BibTeX run completed with code:", code);
            resolve();
          })
        );
      }

      // Second lualatex run
      console.log("Starting second lualatex run...");
      const lualatex2 = spawn("lualatex", lualatexOptions, {
        cwd: dirPath,
        timeout: requestTimeout,
      });
      let stderr2 = "";

      lualatex2.stdout.on("data", (data) => {
        stdout2 += data.toString();
      });

      lualatex2.on("error", (err) => {
        if (err.code === "ETIMEDOUT") {
          console.error(
            `lualatex2 process timed out after ${requestTimeout / 1000} seconds.`
          );
          errors.push(
            `Compilation timed out: lualatex2 process exceeded ${requestTimeout / 1000} seconds.`
          );
        } else {
          console.error(`lualatex2 process error: ${err.message}`);
          errors.push(`lualatex2 process error: ${err.message}`);
        }
      });

      lualatex2.stderr.on("data", (data) => {
        stderr2 += data.toString();
        console.error("lualatex2 stderr:", data.toString());
      });

      await new Promise((resolve) =>
        lualatex2.on("close", (code) => {
          console.log("Second lualatex run completed with code:", code);
          resolve();
        })
      );

      // Third lualatex run
      console.log("Starting third lualatex run...");
      const lualatex3 = spawn("lualatex", lualatexOptions, {
        cwd: dirPath,
        timeout: requestTimeout,
      });
      let stderr3 = "";

      lualatex3.stdout.on("data", (data) => {
        stdout3 += data.toString();
      });

      lualatex3.on("error", (err) => {
        if (err.code === "ETIMEDOUT") {
          console.error(
            `lualatex3 process timed out after ${requestTimeout / 1000} seconds.`
          );
          errors.push(
            `Compilation timed out: lualatex3 process exceeded ${requestTimeout / 1000} seconds.`
          );
        } else {
          console.error(`lualatex3 process error: ${err.message}`);
          errors.push(`lualatex3 process error: ${err.message}`);
        }
      });

      lualatex3.stderr.on("data", (data) => {
        stderr3 += data.toString();
        console.error("lualatex3 stderr:", data.toString());
      });

      await new Promise((resolve) =>
        lualatex3.on("close", (code) => {
          console.log("Third lualatex run completed with code:", code);
          resolve();
        })
      );

      // After successful compilation, clean up downloaded images to save space
      if (imageReferences && Object.keys(imageReferences).length > 0) {
        try {
          const imagesDir = path.join(dirPath, "images");
          // Only remove the images directory if PDF was successfully generated
          const pdfPath = path.join(
            dirPath,
            baseFilename.replace(".tex", ".pdf")
          );
          if (
            (await fs.pathExists(pdfPath)) &&
            (await fs.pathExists(imagesDir))
          ) {
            await fs.remove(imagesDir);
            console.log(`Cleaned up images directory: ${imagesDir}`);
          }
        } catch (cleanupError) {
          console.warn(`Error cleaning up images: ${cleanupError.message}`);
          // Don't fail the request due to cleanup errors
        }
      }

      // Check if PDF exists and try to read it
      try {
        const pdfPath = path.join(
          dirPath,
          baseFilename.replace(".tex", ".pdf")
        );
        console.log("Attempting to read PDF from:", pdfPath);

        // Check if file exists before reading
        const pdfExists = await fs.pathExists(pdfPath);
        console.log(`PDF file exists: ${pdfExists}`);

        if (!pdfExists) {
          throw new Error("PDF file not found at expected path");
        }

        const pdfBuffer = (await fs.readFile(pdfPath)).toString("base64");
        console.log("PDF file read successfully, size:", pdfBuffer.length);

        // Extract any errors/warnings from the output
        const logPath = path.join(
          dirPath,
          baseFilename.replace(".tex", ".log")
        );
        console.log("Reading log file from:", logPath);
        const logContent = await fs.readFile(logPath, "utf-8");
        const errors = parseLatexErrors(logContent);
        console.log("Parsed LaTeX errors:", errors);

        // If we have a PDF, return it as binary data with error info in headers
        // Note: pdfBuffer is already available from line 573

        // Add compilation info to response headers (if not too large)
        const errorInfo = {
          output: formatLatexOutput(stdout1 + stdout2 + stdout3),
          errors: errors,
          warnings: errors.length > 0,
        };

        // Set headers with compilation info (keeping it small)
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Length", pdfBuffer.length);
        res.setHeader("X-LaTeX-Success", "true");
        res.setHeader("X-LaTeX-Warnings", errors.length > 0 ? "true" : "false");
        res.setHeader("X-LaTeX-Error-Count", errors.length.toString());

        // For detailed error info, we'll use a separate endpoint or send minimal info
        // Only include a summary to avoid header size limits
        if (errors.length > 0) {
          const errorSummary = errors
            .slice(0, 3)
            .map((e) => `Line ${e.line}: ${e.type}`)
            .join("; ");
          if (errorSummary.length < 200) {
            res.setHeader("X-LaTeX-Error-Summary", errorSummary);
          }
        }

        return res.status(200).send(pdfBuffer);
      } catch (pdfError) {
        console.error("Failed to read PDF:", pdfError);
        console.error("Error stack:", pdfError.stack);

        // List directory contents to help debug
        try {
          const dirContents = await fs.readdir(dirPath);
          console.log("Directory contents:", dirContents);

          // Check for log file
          const logPath = path.join(
            dirPath,
            baseFilename.replace(".tex", ".log")
          );
          if (await fs.pathExists(logPath)) {
            const logTail = await fs.readFile(logPath, "utf8");
            console.log("Last 1000 characters of log:", logTail.slice(-1000));
          }
        } catch (listError) {
          console.error("Error listing directory:", listError);
        }

        throw new Error(
          `No PDF was generated. Directory contents: ${(await fs.readdir(dirPath)).join(", ")}`
        );
      }
    } catch (error) {
      console.error("Compilation error:", error);
      console.error("Error stack:", error.stack);
      // Try to parse errors from available stdout if possible
      try {
        const combinedOutput = stdout1 + stdout2 + stdout3;
        errors = parseLatexErrors(combinedOutput);
        warnings = errors.some((e) => e.type === "Warning");
      } catch (parseError) {
        console.error("Error parsing LaTeX output:", parseError);
      }

      res.status(500).json({
        error: "PDF compilation failed",
        details: error.message,
        output: formatLatexOutput(
          stdout1 + stdout2 + stdout3 || "No compilation output available"
        ),
        errors: errors,
        warnings: warnings,
      });
    }
  } catch (error) {
    console.error("Top-level error:", error);
    console.error("Error stack:", error.stack);
    // Try to parse errors from available stdout if possible
    try {
      const combinedOutput = stdout1 + stdout2 + stdout3;
      errors = parseLatexErrors(combinedOutput);
      warnings = errors.some((e) => e.type === "Warning");
    } catch (parseError) {
      console.error("Error parsing LaTeX output:", parseError);
    }

    res.status(500).json({
      error: "Server error",
      details: error.message,
      output: formatLatexOutput(
        stdout1 + stdout2 + stdout3 || "No compilation output available"
      ),
      errors: errors,
      warnings: warnings,
    });
  } finally {
    console.log("===== COMPILATION REQUEST COMPLETED =====\n");
  }
});

// Helper function to parse LaTeX errors from log file
const parseLatexErrors = (logContent) => {
  const errors = [];
  let match;

  // Parse LaTeX errors
  const errorRegex = /^(?:.|[\r\n])*?(?:!\s.*\n|.*?:\d+:\s.*\n)/gm;
  while ((match = errorRegex.exec(logContent)) !== null) {
    const errorText = match[0].trim();
    const lineMatch = errorText.match(/:(\d+):/);
    errors.push({
      type: "Error",
      line: lineMatch ? parseInt(lineMatch[1], 10) : null,
      details: errorText.replace(/^!?\s*/, ""),
      context: match[0],
    });
  }

  // Parse LaTeX warnings
  const warningRegex =
    /LaTeX Warning:(.*?)(?:\son\sline\s(\d+)|(?=\n\n|\n[^\\]))/gs;
  while ((match = warningRegex.exec(logContent)) !== null) {
    errors.push({
      type: "Warning",
      line: match[2] ? parseInt(match[2], 10) : null,
      details: match[1].trim().replace(/\n\s*/g, " "),
      context: match[0],
    });
  }

  return errors;
};

// Error handling middleware to catch unhandled errors
app.use((err, req, res, next) => {
  console.error("Unhandled error in Express:", err);
  console.error("Error stack:", err.stack);

  if (!res.headersSent) {
    res.status(500).json({
      error: "Unhandled server error",
      message: err.message,
      details: err.toString(),
    });
  }
});

// Add graceful shutdown to log errors
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  console.error(err.stack);
  // Keep the process running, but log the error
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise);
  console.error("Reason:", reason);
  // Keep the process running, but log the error
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`LaTeX service running on port ${PORT}`));
