class JSONParser {
  constructor() {
    this.maxRetries = 3;
    this.parseAttempts = 0;
  }

  parseJSON(text, source = 'unknown') {
    this.parseAttempts++;
    
    try {
      if (!text || typeof text !== 'string') {
        throw new Error(`Invalid input: expected string, got ${typeof text}`);
      }

      // Clean the text using improved cleaning logic
      const cleaned = this.cleanJSONText(text);
      
      // Try to parse the cleaned text
      const parsed = JSON.parse(cleaned);
      
      // Validate the parsed result
      if (this.validateParsedJSON(parsed)) {
        console.log(`Successfully parsed JSON from ${source}`);
        return parsed;
      } else {
        throw new Error('Parsed JSON failed validation');
      }
      
    } catch (error) {
      console.error(`JSON parse error from ${source}:`, error.message);
      
      // Try fallback parsing methods
      if (this.parseAttempts <= this.maxRetries) {
        return this.tryFallbackParsing(text, source);
      }
      
      // If all attempts fail, return null or throw based on severity
      if (source === 'critical') {
        throw new Error(`Critical JSON parse failure from ${source}: ${error.message}`);
      }
      
      return null;
    } finally {
      // Reset attempts after successful parse or final failure
      if (this.parseAttempts >= this.maxRetries) {
        this.parseAttempts = 0;
      }
    }
  }

  cleanJSONText(text) {
    // Remove markdown code blocks
    text = text.replace(/```json\s*([\s\S]*?)\s*```/g, '$1');
    text = text.replace(/```\s*([\s\S]*?)\s*```/g, '$1');
    
    // Remove control characters but preserve necessary whitespace
    text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ');
    
    // Remove common prefixes that might break JSON
    text = text.replace(/^[^\[\{]*([\[\{])/, '$1');
    
    // Find the JSON boundaries more accurately
    const firstBracket = text.indexOf('[');
    const firstBrace = text.indexOf('{');
    
    if (firstBracket === -1 && firstBrace === -1) {
      throw new Error('No JSON structure found in text');
    }

    const isArray = firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace);
    const startChar = isArray ? '[' : '{';
    const endChar = isArray ? ']' : '}';
    const startIndex = isArray ? firstBracket : firstBrace;

    // Find matching closing bracket/brace
    const endIndex = this.findMatchingBracket(text, startIndex, startChar, endChar);
    
    if (endIndex === -1) {
      throw new Error('No matching closing bracket/brace found');
    }

    return text.slice(startIndex, endIndex + 1).trim();
  }

  findMatchingBracket(text, startIndex, openChar, closeChar) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    
    for (let i = startIndex; i < text.length; i++) {
      const char = text[i];
      
      if (escaped) {
        escaped = false;
        continue;
      }
      
      if (char === '\\') {
        escaped = true;
        continue;
      }
      
      if (char === '"' && !escaped) {
        inString = !inString;
        continue;
      }
      
      if (inString) continue;
      
      if (char === openChar) {
        depth++;
      } else if (char === closeChar) {
        depth--;
        if (depth === 0) {
          return i;
        }
      }
    }
    
    return -1;
  }

  tryFallbackParsing(text, source) {
    console.log(`Attempting fallback parsing for ${source}`);
    
    // Attempt 1: Try to fix common JSON issues
    try {
      let fixed = text
        .replace(/,\s*}/g, '}')  // Remove trailing commas in objects
        .replace(/,\s*]/g, ']')  // Remove trailing commas in arrays
        .replace(/\s+/g, ' ')    // Normalize whitespace
        .trim();
      
      return JSON.parse(fixed);
    } catch (e1) {
      // Attempt 2: Try to extract just the JSON part more aggressively
      try {
        const jsonMatch = text.match(/[\[\{][\s\S]*[\]\}]/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]);
        }
      } catch (e2) {
        // Attempt 3: Try eval as last resort (dangerous, but controlled)
        try {
          console.warn(`Using eval fallback for ${source} - this is risky`);
          const evalResult = eval('(' + text + ')');
          if (typeof evalResult === 'object') {
            return evalResult;
          }
        } catch (e3) {
          console.error(`All parsing attempts failed for ${source}`);
        }
      }
    }
    
    return null;
  }

  validateParsedJSON(parsed) {
    if (parsed === null || parsed === undefined) {
      return false;
    }
    
    // If it's an array, validate it has reasonable structure
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) return true; // Empty arrays are valid
      
      // Check if array elements are reasonable (objects with properties)
      const sample = parsed[0];
      return typeof sample === 'object' && sample !== null;
    }
    
    // If it's an object, validate it has some properties
    if (typeof parsed === 'object') {
      return Object.keys(parsed).length > 0;
    }
    
    // Primitive values are generally not what we expect from API responses
    return false;
  }

  safeParseJSON(text, defaultValue = null, source = 'unknown') {
    try {
      return this.parseJSON(text, source) || defaultValue;
    } catch (error) {
      console.warn(`Safe JSON parse returned default value for ${source}:`, error.message);
      return defaultValue;
    }
  }
}

module.exports = new JSONParser();