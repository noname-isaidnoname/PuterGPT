// Compression utilities for sharing conversations via URLs
// Uses LZ-string for efficient compression/decompression

// Import LZ-string (will be loaded via CDN in HTML)
const LZString = window.LZString;

function compressChatData(chatData) {
    try {
        // Convert chat data to JSON string
        const jsonString = JSON.stringify(chatData);

        // Compress using LZ-string
        const compressed = LZString.compressToEncodedURIComponent(jsonString);

        return compressed;
    } catch (error) {
        console.error('Failed to compress chat data:', error);
        throw new Error('Failed to compress conversation data');
    }
}

function decompressChatData(compressedData) {
    try {
        // Decompress using LZ-string
        const decompressed = LZString.decompressFromEncodedURIComponent(compressedData);

        if (!decompressed) {
            throw new Error('Invalid compressed data');
        }

        // Parse JSON
        const chatData = JSON.parse(decompressed);
        return chatData;
    } catch (error) {
        console.error('Failed to decompress chat data:', error);
        throw new Error('Failed to load shared conversation data');
    }
}

export function generateShareUrl(chatData) {
    try {
        const compressed = compressChatData(chatData);
        
        // Check if current origin is a websim.com domain and use production URL
        const isWebsimDomain = window.location.hostname.includes('.c.websim.com');
        const baseUrl = isWebsimDomain 
            ? 'https://putergpt.on.websim.com' + window.location.pathname
            : window.location.origin + window.location.pathname;
            
        const shareUrl = `${baseUrl}#shared=${compressed}`;

        return shareUrl;
    } catch (error) {
        console.error('Failed to generate share URL:', error);
        throw error;
    }
}

export function parseSharedUrl() {
    try {
        const hash = window.location.hash;
        if (!hash.startsWith('#shared=')) {
            return null;
        }

        const compressedData = hash.substring(8); // Remove '#shared='
        const chatData = decompressChatData(compressedData);

        return chatData;
    } catch (error) {
        console.error('Failed to parse shared URL:', error);
        return null;
    }
}
