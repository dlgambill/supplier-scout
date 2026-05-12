const Joi = require('joi');

class ValidationService {
  constructor() {
    // Updated supplier schema with more comprehensive validation
    this.supplierSchema = Joi.object({
      name: Joi.string().min(1).max(200).required(),
      location: Joi.string().allow('', 'N/A', 'Unknown').max(100),
      specialty: Joi.string().allow('').max(500),
      tags: Joi.array().items(Joi.string().max(50)).default([]),
      email: Joi.string().email().allow('').max(100),
      phone: Joi.string().allow('').max(50),
      website: Joi.string().uri().allow('').max(200),
      description: Joi.string().allow('').max(1000),
      confidence: Joi.number().min(0).max(1).default(0.5)
    });

    this.searchParamsSchema = Joi.object({
      query: Joi.string().min(1).max(200).required(),
      supplierType: Joi.string().valid('all', 'manufacturers', 'distributors').default('all'),
      scope: Joi.string().valid('all', 'domestic', 'foreign').default('all'),
      countries: Joi.array().items(Joi.string().max(50)).default([]),
      selectedCountries: Joi.array().items(Joi.string().max(50)).default([]),
      limit: Joi.number().integer().min(1).max(500).default(50)
    });
  }

  validateSupplier(supplier) {
    const { error, value } = this.supplierSchema.validate(supplier, { 
      stripUnknown: true,
      convert: true 
    });
    
    if (error) {
      console.warn('Supplier validation failed:', error.details[0].message, supplier);
      return null;
    }
    
    return value;
  }

  validateSuppliers(suppliers) {
    if (!Array.isArray(suppliers)) {
      console.error('Suppliers validation failed: not an array');
      return [];
    }

    const validSuppliers = [];
    let invalidCount = 0;

    for (const supplier of suppliers) {
      const validSupplier = this.validateSupplier(supplier);
      if (validSupplier) {
        validSuppliers.push(validSupplier);
      } else {
        invalidCount++;
      }
    }

    if (invalidCount > 0) {
      console.warn(`Filtered out ${invalidCount} invalid suppliers`);
    }

    return validSuppliers;
  }

  validateSearchParams(params) {
    const { error, value } = this.searchParamsSchema.validate(params, {
      stripUnknown: true,
      convert: true
    });

    if (error) {
      throw new Error(`Search params validation failed: ${error.details[0].message}`);
    }

    return value;
  }

  validateApiResponse(response, source) {
    try {
      if (!response) {
        throw new Error('Empty response');
      }

      if (typeof response === 'string') {
        // Attempt to parse JSON if it's a string
        try {
          response = JSON.parse(response);
        } catch (parseError) {
          throw new Error(`Invalid JSON response from ${source}: ${parseError.message}`);
        }
      }

      // Basic structure validation
      if (typeof response !== 'object') {
        throw new Error(`Invalid response type from ${source}: expected object`);
      }

      return response;
    } catch (error) {
      console.error(`API response validation failed for ${source}:`, error.message);
      return null;
    }
  }

  sanitizeInput(input) {
    if (typeof input !== 'string') return input;
    
    // Remove potentially dangerous characters and limit length
    return input
      .replace(/[<>"'&]/g, '') // Remove HTML/script injection chars
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ') // Remove control characters
      .trim()
      .substring(0, 1000); // Limit length
  }

  isValidEmail(email) {
    if (!email || typeof email !== 'string') return false;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email) && email.length <= 100;
  }

  isValidUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = new ValidationService();