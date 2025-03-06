import { createClient } from '@/utils/supabase/server';
import { getSections } from '@/utils/supabase/queries';
import { convertBlockNoteToLatex } from '@/utils/latex/converter';
import { manager } from '@/utils/y-sweet-document-manager';
import * as Y from 'yjs';
import { DOMParser } from 'xmldom';
import { getPaperMetadataWithDetails } from '@/utils/supabase/papermetadataqueries';
import { generateBibTeX } from '@/utils/bibtexGenerator';
import * as fs from 'fs/promises';
import path from 'path';
import imageCompression from 'browser-image-compression';

// Define the function outside
function processStyledNode(el: Element, currentStyles: string[] = []): any[] {
    const styles = [...currentStyles];
    const nodeType = el.tagName.toLowerCase();

    if (['bold', 'italic', 'underline'].includes(nodeType)) {
        styles.push(nodeType);
    }

    return Array.from(el.childNodes).flatMap(child => {
        if (child.nodeType === 3) { // Text node
            return [{
                type: 'text',
                text: child.textContent || '',
                styles: styles
            }];
        }
        if (child.nodeType === 1) { // Element node
            return processStyledNode(child as Element, styles);
        }
        return [];
    });
}

// Function to extract BlockNote content from Y.js document
function extractContent(ydoc: Y.Doc, sectionId?: string, enableLogging = true) {
    const xmlFragment = ydoc.get('blocknote', Y.XmlFragment);

    if (!xmlFragment) {
        console.warn('No "blocknote" XmlFragment found in YDoc');
        return [];
    }

    const xmlString = xmlFragment.toString();

    // Only write files if logging is enabled
    if (enableLogging) {
        // Write full XML to file
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `blocknote-xml-${sectionId || 'unknown'}-${timestamp}.txt`;

        // Use an absolute path that's easier to find
        const logDir = path.join(process.cwd(), 'logs');
        console.log('Writing logs to directory:', logDir);

        // Make this function synchronous to ensure files are written
        const writeXmlToFile = async () => {
            try {
                await fs.mkdir(logDir, { recursive: true });
                const fullPath = path.join(logDir, filename);
                await fs.writeFile(fullPath, xmlString);
                console.log(`Full XML written to ${fullPath}`);
            } catch (error) {
                console.error('Error writing XML to file:', error);
            }
        };

        // Execute the file write
        writeXmlToFile();
    }

    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlString, 'text/xml');

    // First find the blockgroup element
    const blockgroup = xmlDoc.getElementsByTagName('blockgroup')[0];
    if (!blockgroup) {
        console.warn('No blockgroup found');
        return [];
    }

    // Then get all blockcontainers within the blockgroup
    const blockContainers = Array.from(blockgroup.getElementsByTagName('blockcontainer'));
    console.log(`Found ${blockContainers.length} block containers`);

    // Write all block containers to file if logging is enabled
    if (enableLogging) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const blocksFilename = `blocks-${sectionId || 'unknown'}-${timestamp}.txt`;
        const logDir = path.join(process.cwd(), 'logs');

        const writeBlocksToFile = async () => {
            try {
                await fs.mkdir(logDir, { recursive: true });
                const blocksContent = blockContainers.map((container, idx) =>
                    `\n\n==== BLOCK ${idx} ====\n${container.toString()}`
                ).join('\n');
                const fullPath = path.join(logDir, blocksFilename);
                await fs.writeFile(fullPath, blocksContent);
                console.log(`All blocks written to ${fullPath}`);
            } catch (error) {
                console.error('Error writing blocks to file:', error);
            }
        };

        // Execute the file write
        writeBlocksToFile();
    }

    const blocks = blockContainers.map((container, index) => {
        try {
            // Check for imageBlock first
            const imageBlock = container.getElementsByTagName('imageblock')[0];
            if (imageBlock) {
                // Extract image block properties
                return {
                    type: 'imageBlock',
                    props: {
                        imageId: imageBlock.getAttribute('imageId') || '',
                        imageName: imageBlock.getAttribute('imageName') || 'Image',
                        imageUrl: imageBlock.getAttribute('imageUrl') || '',
                        caption: imageBlock.getAttribute('caption') || '',
                        textAlignment: imageBlock.getAttribute('textAlignment') || 'center',
                        docId: imageBlock.getAttribute('docId') || '',
                    }
                };
            }

            // Continue with existing code for other block types
            const child = container.getElementsByTagName('paragraph')[0] ||
                container.getElementsByTagName('heading')[0];

            if (!child) {
                return null;
            }

            const type = child.tagName.toLowerCase();

            // Instead of just getting textContent, we need to process child nodes
            const content = Array.from(child.childNodes).map(node => {
                if (node.nodeType === 3) { // Text node
                    return {
                        type: 'text',
                        text: node.textContent || ''
                    };
                }

                if (node.nodeType === 1) { // Element node
                    const element = node as Element;
                    const tagName = element.tagName.toLowerCase();

                    // Handle special mentions
                    if (tagName === 'tablemention') {
                        return {
                            type: 'text',
                            text: `\\ref{${element.getAttribute('tableName')}}`
                        };
                    }

                    if (tagName === 'sourcemention') {
                        return {
                            type: 'text',
                            text: `\\cite{${element.getAttribute('sourceName')}}`
                        };
                    }

                    // Use the function defined above
                    return processStyledNode(element);
                }

                return null;
            }).flat().filter(Boolean);

            if (type === 'paragraph') {
                return {
                    type: 'paragraph',
                    content
                };
            } else if (type === 'heading') {
                const level = parseInt(child.getAttribute('level') || '1');
                return {
                    type: 'heading',
                    props: {
                        level: level
                    },
                    content
                };
            }

            console.log(`Unhandled block type: ${type}`);

            return null;
        } catch (error) {
            console.error(`Error processing block ${index}:`, error);
            return null;
        }
    }).filter(Boolean);

    // Write processed blocks to file if logging is enabled
    if (enableLogging) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const processedBlocksFilename = `processed-blocks-${sectionId || 'unknown'}-${timestamp}.txt`;
        const logDir = path.join(process.cwd(), 'logs');

        const writeProcessedBlocksToFile = async () => {
            try {
                await fs.mkdir(logDir, { recursive: true });
                const fullPath = path.join(logDir, processedBlocksFilename);
                await fs.writeFile(
                    fullPath,
                    JSON.stringify(blocks, null, 2)
                );
                console.log(`Processed blocks written to ${fullPath}`);
            } catch (error) {
                console.error('Error writing processed blocks to file:', error);
            }
        };

        // Execute the file write
        writeProcessedBlocksToFile();
    }

    return blocks;
}

// Add this helper function at the top level
async function getDocWithRetry(docId: string, maxRetries = 3): Promise<Uint8Array | null> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await manager.getDocAsUpdate(docId);
        } catch (error: any) {
            if (error?.message?.includes('429') && attempt < maxRetries) {
                // Wait with exponential backoff: 1s, 2s, 4s, etc.
                const delay = Math.pow(2, attempt - 1) * 1000;
                console.log(`Rate limited, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }
            throw error;
        }
    }
    return null;
}

// Add function to collect and validate image references
function collectImageReferences(sections: any[]) {
    console.log(`Collecting image references from ${sections.length} sections`);
    const imageRefs: Record<string, any> = {};

    sections.forEach((section: any, sectionIndex: number) => {
        if (!section.content || !Array.isArray(section.content)) {
            return;
        }

        // Find image blocks
        const imageBlocks = section.content.filter(
            (block: any) => block && (block.type === 'imageBlock' || block.type === 'imageblock')
        );

        console.log(`Found ${imageBlocks.length} image blocks in section ${sectionIndex + 1} (${section.name || 'Unnamed'})`);

        imageBlocks.forEach((block: any, blockIndex: number) => {
            const imageId = block.props?.imageId;
            const imageUrl = block.props?.imageUrl;
            const imageName = block.props?.imageName || 'Image';

            if (!imageId || !imageUrl) {
                console.warn(`Image block ${blockIndex} missing ID or URL:`, {
                    hasId: !!imageId,
                    hasUrl: !!imageUrl
                });
                return;
            }

            // Create a safe ID for the image
            const safeImageId = imageId.replace(/[^a-zA-Z0-9]/g, '_');

            // Try to extract extension from URL
            let fileExtension = 'jpg'; // Default
            try {
                const urlObj = new URL(imageUrl);
                const pathname = urlObj.pathname;
                const extension = pathname.split('.').pop();
                if (extension && ['jpg', 'jpeg', 'png', 'pdf'].includes(extension.toLowerCase())) {
                    fileExtension = extension;
                }
            } catch (e) {
                console.warn(`Could not parse URL for extension: ${imageUrl}`);
            }

            // Validate the URL format
            let isValidUrl = false;
            try {
                const urlObj = new URL(imageUrl);
                isValidUrl = urlObj.protocol === 'http:' || urlObj.protocol === 'https:';
            } catch (e) {
                console.error(`Invalid image URL format: ${imageUrl}`);
            }

            if (isValidUrl) {
                imageRefs[safeImageId] = {
                    id: imageId,
                    url: imageUrl,
                    name: imageName,
                    filename: `${safeImageId}.${fileExtension}`,
                    section: section.name || 'Unnamed'
                };
                console.log(`Added image reference: ${safeImageId} -> ${imageUrl}`);
            } else {
                console.warn(`Skipping invalid image URL: ${imageUrl}`);
            }
        });
    });

    console.log(`Collected ${Object.keys(imageRefs).length} valid image references`);
    return imageRefs;
}

// Add a function to pre-download images on the client side
async function downloadAndEncodeImages(imageReferences: Record<string, any>) {
    console.log(`Pre-downloading and compressing ${Object.keys(imageReferences).length} images`);

    const updatedImageRefs = { ...imageReferences };
    const MAX_IMAGE_SIZE_MB = 2; // 2MB threshold for compression

    await Promise.all(
        Object.keys(imageReferences).map(async (key) => {
            const image = imageReferences[key];
            try {
                console.log(`Processing image ${image.id} from ${image.url}`);

                // Make the request from the client side where the auth token should work
                const response = await fetch(image.url);

                if (!response.ok) {
                    throw new Error(`Failed to download image: ${response.status} ${response.statusText}`);
                }

                // Get image as blob
                const imageBlob = await response.blob();
                const contentType = response.headers.get('content-type') || 'image/jpeg';

                // Check if image is large and needs compression
                const imageSizeMB = imageBlob.size / (1024 * 1024);

                if (imageSizeMB > MAX_IMAGE_SIZE_MB) {
                    console.log(`Image ${image.id} is large (${imageSizeMB.toFixed(2)}MB), compressing...`);

                    try {
                        // Compression options
                        const options = {
                            maxSizeMB: MAX_IMAGE_SIZE_MB,
                            maxWidthOrHeight: 1920,
                            useWebWorker: true,
                            fileType: contentType
                        };

                        // Compress the image
                        const compressedBlob = await imageCompression(imageBlob as File, options);
                        const compressedSizeMB = compressedBlob.size / (1024 * 1024);

                        console.log(`Compressed image ${image.id} from ${imageSizeMB.toFixed(2)}MB to ${compressedSizeMB.toFixed(2)}MB`);

                        // Convert compressed blob to base64
                        const base64 = await blobToBase64(compressedBlob);

                        // Add the compressed base64 data to the image reference
                        updatedImageRefs[key] = {
                            ...image,
                            base64Data: base64.split(',')[1], // Remove the data URL prefix
                            contentType: compressedBlob.type,
                            originalSize: imageBlob.size,
                            compressedSize: compressedBlob.size
                        };
                    } catch (compressError) {
                        console.error(`Error compressing image ${image.id}:`, compressError);
                        console.log("Falling back to original image");

                        // Fall back to original image if compression fails
                        const base64 = await blobToBase64(imageBlob);
                        updatedImageRefs[key] = {
                            ...image,
                            base64Data: base64.split(',')[1],
                            contentType: contentType
                        };
                    }
                } else {
                    // For smaller images, just use the original data
                    const base64 = await blobToBase64(imageBlob);

                    // Add the base64 data to the image reference
                    updatedImageRefs[key] = {
                        ...image,
                        base64Data: base64.split(',')[1],
                        contentType: contentType
                    };
                }

                console.log(`Successfully processed image ${image.id}`);
            } catch (error) {
                console.error(`Error processing image ${image.id}:`, error);
                // Keep the original reference without base64 data
            }
        })
    );

    return updatedImageRefs;
}

// Helper function to convert Blob to base64
function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

export async function GET(
    request: Request,
    context: { params: Promise<{ paperId: string }> }
) {
    try {
        const paperId = (await context.params).paperId;
        const template = new URL(request.url).searchParams.get('template') || 'default';
        const format = new URL(request.url).searchParams.get('format') || 'latex';
        const path = new URL(request.url).searchParams.get('path') || 'mdpi/template.tex';
        const paperType = new URL(request.url).searchParams.get('paperType') || 'academic';
        const enableLogging = new URL(request.url).searchParams.get('logging') !== 'false';

        console.log('Starting LaTeX generation:', { paperId, template, format, path, paperType, enableLogging });

        const supabase = createClient();

        // Log paper fetch
        console.log('Fetching paper data...');
        const { data: paperData, error: paperError } = await supabase
            .from("docs")
            .select("num_id, name, paper_type")
            .eq("id", paperId)
            .single();

        if (paperError || !paperData) {
            console.error('Paper fetch error:', paperError);
            return Response.json(
                { error: 'Failed to fetch paper', details: paperError },
                { status: 500 }
            );
        }
        console.log('Paper data fetched:', paperData);

        let sectionsWithContent = [];

        // For simple papers, process the main document directly
        if (paperType === 'simple' || paperData.paper_type === 'simple') {
            console.log('Processing simple paper content...');
            try {
                // Get the main document content
                const yDocData = await getDocWithRetry(paperId);

                if (!yDocData) {
                    console.warn(`No Y.js data found for simple paper ${paperId}`);
                    return Response.json(
                        { error: 'No content found for simple paper' },
                        { status: 500 }
                    );
                }

                const ydoc = new Y.Doc();
                Y.applyUpdate(ydoc, yDocData);
                const content = extractContent(ydoc, undefined, enableLogging);

                // Create a single "section" with all the content
                sectionsWithContent = [{
                    id: paperId,
                    name: paperData.name || "Document",
                    content: content
                }];
            } catch (error) {
                console.error('Error processing simple paper content:', error);
                return Response.json(
                    { error: 'Failed to process simple paper content', details: error },
                    { status: 500 }
                );
            }
        } else {
            // For academic papers, get sections as before
            console.log('Fetching sections for academic paper...');
            const { data: sections, error } = await getSections(paperData.num_id);
            console.log('Sections found:', sections?.length || 0, 'sections');

            if (error || !sections) {
                console.error('Sections fetch error:', error);
                return Response.json(
                    { error: 'Failed to fetch sections', details: error },
                    { status: 500 }
                );
            }

            // Process section content as before
            console.log('Processing section contents...');
            sectionsWithContent = await Promise.all(
                sections.map(async (section) => {
                    try {
                        console.log(`Processing section ${section.id} (${section.name})...`);
                        const yDocData = await getDocWithRetry(section.id);

                        if (!yDocData) {
                            console.warn(`No Y.js data found for section ${section.id}`);
                            return { ...section, content: [] };
                        }

                        const ydoc = new Y.Doc();
                        Y.applyUpdate(ydoc, yDocData);
                        console.log(`Section ${section.id}: Extracting content from YDoc...`);
                        const content = enableLogging
                            ? extractContent(ydoc, section.id, true)
                            : extractContent(ydoc, section.id, false);
                        console.log(`Section ${section.id}: Found ${content.length} blocks`);

                        return {
                            ...section,
                            content
                        };
                    } catch (sectionError) {
                        console.error(`Error processing section ${section.id}:`, sectionError);
                        return {
                            ...section,
                            content: [],
                            error: sectionError instanceof Error ? sectionError.message : 'Unknown error'
                        };
                    }
                })
            );
        }


        // Log metadata fetch
        console.log('Fetching metadata...');
        const { data: metadataData, error: metadataError } = await getPaperMetadataWithDetails(paperId);

        if (metadataError) {
            console.error('Metadata fetch error:', metadataError);
            return Response.json(
                { error: 'Failed to fetch metadata', details: metadataError },
                { status: 500 }
            );
        }
        console.log('Metadata fetched successfully');

        // Log sources fetch
        console.log('Fetching sources...');
        const { data: sources, error: sourcesError } = await supabase
            .from("sources")
            .select("*")
            .eq("doc_id", paperId);

        if (sourcesError) {
            console.error('Sources fetch error:', sourcesError);
            return Response.json(
                { error: 'Failed to fetch sources', details: sourcesError },
                { status: 500 }
            );
        }
        console.log(`Found ${sources?.length || 0} sources`);

        // Generate BibTeX content
        const bibContent = sources?.map(source => generateBibTeX(source)).join("\n") || '';

        // Log LaTeX conversion
        console.log('Converting to LaTeX...');
        const { latex, imageRefs } = await convertBlockNoteToLatex(
            sectionsWithContent,
            {
                templateId: template,
                documentClass: 'article',
                fontSize: '12pt',
                paperSize: 'a4paper'
            },
            metadataData?.metadata || {},
            metadataData?.authors || [],
            metadataData?.fundingSources || []
        );
        console.log(`LaTeX conversion completed with ${Object.keys(imageRefs || {}).length} image references`);

        if (format === 'pdf') {
            console.log('Preparing for PDF generation');

            // Collect image references
            const imageReferences = collectImageReferences(sectionsWithContent);
            console.log(`Found ${Object.keys(imageReferences).length} image references`);

            // Download images on the client side
            const downloadedImages = await downloadAndEncodeImages(imageReferences);

            try {
                // Prepare the request body
                const compilationRequest = {
                    content: latex,
                    filename: path,
                    template: template,
                    bibliography: {
                        content: bibContent,
                        filename: 'references.bib'
                    },
                    imageReferences: downloadedImages // Use downloaded images with base64 data
                };

                // Log the request details (excluding the full content for brevity)
                console.log('Sending compilation request to LaTeX service:');
                console.log(`URL: https://latex.writemine.com/compile`);
                console.log(`Content length: ${latex.length} characters`);
                console.log(`Bibliography length: ${bibContent.length} characters`);
                console.log(`Image references: ${Object.keys(downloadedImages).length}`);
                console.log(`Image reference keys: ${Object.keys(downloadedImages).join(', ')}`);

                // Add detailed request and response logging
                console.log('Sending request to LaTeX compilation service...');
                const startTime = Date.now();

                const response = await fetch('https://latex.writemine.com/compile', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-API-Key': process.env.LATEX_SERVICE_API_KEY!,
                        'User-Agent': 'WriteServiceAPI/1.0',
                    },
                    body: JSON.stringify(compilationRequest)
                });

                const duration = Date.now() - startTime;
                console.log(`Received response after ${duration}ms`);
                console.log(`Status: ${response.status} ${response.statusText}`);
                console.log(`Headers: ${JSON.stringify(Object.fromEntries(response.headers.entries()))}`);

                // Check for non-JSON response which might indicate an error
                const contentType = response.headers.get('content-type');
                if (!contentType || !contentType.includes('application/json')) {
                    console.error(`Received non-JSON response: ${contentType}`);

                    // Get the response text
                    const responseText = await response.text();
                    console.error(`Response text (first 1000 chars): ${responseText.substring(0, 1000)}`);

                    throw new Error(`LaTeX service returned non-JSON response: ${contentType}\n${responseText.substring(0, 500)}...`);
                }

                // Parse the JSON response with error handling
                let responseData;
                try {
                    responseData = await response.json();
                    console.log('Successfully parsed JSON response');
                    console.log(`Response has PDF: ${!!responseData.pdf}`);
                    console.log(`PDF size: ${responseData.pdf ? responseData.pdf.length : 0} characters`);
                } catch (jsonError) {
                    console.error('Error parsing JSON response:', jsonError);

                    // Try to get the raw text response
                    try {
                        const responseText = await response.text();
                        console.error(`Response text (first 1000 chars): ${responseText.substring(0, 1000)}`);
                        throw new Error(`Failed to parse JSON response: ${jsonError instanceof Error ? jsonError.message : 'Unknown error'}\n${responseText.substring(0, 500)}...`);
                    } catch (textError) {
                        console.error('Error getting response text:', textError);
                        throw jsonError; // Throw the original error if we can't get the text
                    }
                }

                // Return both PDF and any compilation warnings/errors
                if (responseData.pdf) {
                    console.log('PDF generated successfully');

                    // Convert base64 to buffer
                    const pdfBuffer = Buffer.from(responseData.pdf, 'base64');
                    console.log(`PDF size in bytes: ${pdfBuffer.length}`);

                    return new Response(pdfBuffer, {
                        headers: {
                            'Content-Type': 'application/pdf',
                            'Content-Disposition': `attachment; filename="paper_${paperId}.pdf"`,
                            'X-LaTeX-Output': JSON.stringify({
                                output: responseData.output,
                                errors: responseData.errors,
                                warnings: responseData.warnings
                            })
                        }
                    });
                }

                // If we don't have a PDF, throw an error with the response details
                console.error('No PDF in response:', responseData);
                throw new Error(JSON.stringify({
                    status: response.status,
                    statusText: response.statusText,
                    details: responseData
                }));
            } catch (error) {
                console.error('LaTeX compilation error:', error);

                // Extract as much information as possible from the error
                let errorMessage = 'Failed to generate PDF';
                let errorDetails = {};

                // Try to parse the error message as JSON if possible
                try {
                    // Check if error message is already an object
                    if (typeof error === 'object' && error !== null) {
                        errorMessage = 'message' in error ? error.message as string : 'Unknown error';
                        errorDetails = error;
                    }
                    // Check if error message is JSON string
                    else if (error instanceof Error && typeof error.message === 'string' && error.message.startsWith('{')) {
                        const parsedError = JSON.parse(error.message);
                        errorMessage = `LaTeX compilation failed (${parsedError.status}: ${parsedError.statusText})`;
                        errorDetails = parsedError.details || parsedError;
                    }
                    // Otherwise just use the message
                    else {
                        errorMessage = error instanceof Error ? error.message : 'Unknown error';
                        errorDetails = { stack: error instanceof Error ? error.stack : undefined };
                    }
                } catch (e) {
                    // If parsing fails, use the original error message
                    errorMessage = error instanceof Error ? error.message : 'Unknown error';
                    errorDetails = { parseError: e instanceof Error ? e.message : String(e), originalError: String(error) };
                }

                // Return detailed error information
                return Response.json(
                    {
                        error: errorMessage,
                        details: errorDetails,
                        latex: latex.substring(0, 500) + '...', // Include start of LaTeX for debugging
                        imageReferences: Object.keys(downloadedImages || {}).length
                    },
                    { status: 500 }
                );
            }
        }

        // Default LaTeX response - now with proper encoding
        console.log('Returning LaTeX content');
        const filename = `paper_${paperId}.tex`;

        // Create a TextEncoder to properly handle Unicode characters
        const encoder = new TextEncoder();
        const encodedLatex = encoder.encode(latex);

        return new Response(encodedLatex, {
            headers: {
                'Content-Type': 'application/x-latex; charset=utf-8',
                'Content-Disposition': `attachment; filename="${filename}"`,
            },
        });
    } catch (error) {
        console.error('Top-level error:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const errorStack = error instanceof Error ? error.stack : undefined;

        // Also ensure error response is properly encoded
        return new Response(
            JSON.stringify({
                error: 'Internal server error',
                message: errorMessage,
                stack: errorStack,
                details: error
            }),
            {
                status: 500,
                headers: {
                    'Content-Type': 'application/json; charset=utf-8'
                }
            }
        );
    }
}
