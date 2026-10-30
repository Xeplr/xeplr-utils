// `multer` is an optional peer dep — lazy-loaded so projects that
// don't handle multipart uploads don't have to install it.
let _multer = null;
function loadMulter() {
  if (_multer) return _multer;
  try { _multer = require('multer'); return _multer; }
  catch (e) {
    var err = new Error(
      "@xeplr/utils/lib/fileUploader: 'multer' is not installed. Run `npm install multer` " +
      "in your project. It's an optional peer dependency — only required if you handle file uploads."
    );
    err.cause = e;
    throw err;
  }
}

const path = require('path');
const fs = require('fs');
const { generateId } = require('./helpers');

/**
 * The requesting tenant's uploads/ — @xeplr/db's folder module (an optional
 * peer, needed only when no destination is named; without it, Node's own
 * "Cannot find module '@xeplr/db'" says so). The module alone: the package's
 * entry also opens connections.
 */
function tenantUploads() {
  return require('@xeplr/db/lib/dataDir').resolve('uploads', 'The uploads folder');
}

class FileUploader {
  /**
   * @param {object} options
   * @param {function} options.auth - Auth function: receives (req), must return truthy or throw
   * @param {string[]} [options.allowedTypes] - MIME types: ['image/png', 'image/*', '*']
   * @param {number} [options.maxSize] - Max file size in bytes (default: 5MB)
   * @param {string|function} [options.destination] - Upload directory, or
   *   (req) => directory, asked for EACH upload. Made if missing. A function
   *   that throws refuses the upload with its message.
   *   DEFAULT: the requesting tenant's own uploads/ under XEPLR_DATA_DIR
   *   (@xeplr/db's dataDir) — never one folder for every company, which is
   *   what UPLOAD_DIR and ./uploads were. A request with no tenant is refused.
   */
  constructor(options = {}) {
    this._auth = options.auth || null;
    this._allowedTypes = options.allowedTypes || ['*'];
    this._maxSize = options.maxSize || 5 * 1024 * 1024;
    this._destination = options.destination || tenantUploads;

    if (typeof this._destination !== 'function' && !fs.existsSync(this._destination)) {
      fs.mkdirSync(this._destination, { recursive: true });
    }

    var multer = loadMulter();
    this._multer = multer({
      storage: multer.diskStorage({
        destination: (req, file, cb) => {
          if (typeof this._destination !== 'function') return cb(null, this._destination);
          Promise.resolve().then(() => this._destination(req)).then(function(dir) {
            fs.mkdirSync(dir, { recursive: true });
            cb(null, dir);
          }, function(err) { cb(err); });
        },
        filename: (req, file, cb) => {
          var ext = path.extname(file.originalname);
          var name = generateId() + ext;
          cb(null, name);
        }
      }),
      limits: {
        fileSize: this._maxSize
      },
      fileFilter: (req, file, cb) => {
        if (this._isTypeAllowed(file.mimetype)) {
          cb(null, true);
        } else {
          cb(new Error('File type not allowed: ' + file.mimetype));
        }
      }
    });
  }

  _isTypeAllowed(mimetype) {
    for (var i = 0; i < this._allowedTypes.length; i++) {
      var allowed = this._allowedTypes[i];
      if (allowed === '*') return true;
      if (allowed.endsWith('/*')) {
        var category = allowed.split('/')[0];
        if (mimetype.startsWith(category + '/')) return true;
      }
      if (allowed === mimetype) return true;
    }
    return false;
  }

  _authGuard() {
    var auth = this._auth;
    return async function(req, res, next) {
      if (!auth) return next();
      try {
        var result = await auth(req);
        if (!result) {
          res.writeHead ? _jsonResponse(res, 401, { error: 'Unauthorized' })
            : res.status(401).json({ error: 'Unauthorized' });
          return;
        }
        next();
      } catch (err) {
        res.writeHead ? _jsonResponse(res, 401, { error: err.message || 'Unauthorized' })
          : res.status(401).json({ error: err.message || 'Unauthorized' });
      }
    };
  }

  _errorHandler() {
    return function(err, req, res, next) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'File too large' });
      }
      if (err.message && err.message.startsWith('File type not allowed')) {
        return res.status(400).json({ error: err.message });
      }
      // A refusal that says its own status (a folder function's "no tenant")
      // is answered with it, not as a server fault.
      if (err.status >= 400 && err.status < 500) {
        return res.status(err.status).json({ error: err.message });
      }
      return res.status(500).json({ error: err.message || 'Upload failed' });
    };
  }

  /**
   * Accept a single file upload.
   * @param {string} fieldName - Form field name
   * @returns {function[]} Express middleware chain
   */
  single(fieldName) {
    var guard = this._authGuard();
    var upload = this._multer.single(fieldName);
    var errorHandler = this._errorHandler();
    return [guard, upload, errorHandler];
  }

  /**
   * Accept multiple file uploads on a single field.
   * @param {string} fieldName - Form field name
   * @param {number} [maxCount=10] - Maximum number of files
   * @returns {function[]} Express middleware chain
   */
  array(fieldName, maxCount) {
    var guard = this._authGuard();
    var upload = this._multer.array(fieldName, maxCount || 10);
    var errorHandler = this._errorHandler();
    return [guard, upload, errorHandler];
  }

  /**
   * Accept file uploads on multiple fields.
   * @param {Array<{name: string, maxCount: number}>} fields
   * @returns {function[]} Express middleware chain
   */
  fields(fields) {
    var guard = this._authGuard();
    var upload = this._multer.fields(fields);
    var errorHandler = this._errorHandler();
    return [guard, upload, errorHandler];
  }
}

function _jsonResponse(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

module.exports = FileUploader;
