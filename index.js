// index.js
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const axios = require('axios');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const readline = require('readline'); // Import readline for interactive mode

// Add error logging setup
const ERROR_LOG_FILE = 'error_log.csv';
const errorLogStream = fs.createWriteStream(ERROR_LOG_FILE, { flags: 'a' });
if (!fs.existsSync(ERROR_LOG_FILE)) {
  errorLogStream.write('timestamp,rowNumber,requestName,statusCode,errorMessage\n');
}

function logError(rowNumber, requestName, statusCode, errorMessage) {
  const timestamp = new Date().toISOString();
  errorLogStream.write(`${timestamp},${rowNumber},${requestName},${statusCode},"${errorMessage.replace(/"/g, '""')}"\n`);
}

// Command line arguments
const argv = yargs(hideBin(process.argv))
  .option('csv', {
    alias: 'c',
    description: 'Path to the primary CSV file',
    type: 'string',
    demandOption: true
  })
  .option('loop-csv', {
    alias: 'l',
    description: 'Path to the secondary CSV file for looping',
    type: 'string'
  })
  .option('config', {
    alias: 'f',
    description: 'Path to the JSON configuration file',
    type: 'string',
    demandOption: function() {
      return !argv.generateConfig;
    }
  })
  .option('apikey', {
    alias: 'k',
    description: 'API key for authentication',
    type: 'string',
    demandOption: function() {
      return !argv.generateConfig;
    }
  })
  .option('delay', {
    alias: 'd',
    description: 'Delay between requests in milliseconds',
    type: 'number',
    default: 0
  })
  .option('generate-config', {
    description: 'Generate a basic config file from CSV headers',
    type: 'boolean',
    default: false
  })
  .option('output-config', {
    description: 'Specify output file for generated config',
    type: 'string'
  })
  .option('interactive', {
    description: 'Run in interactive mode, prompting for each request',
    type: 'boolean',
    default: false
  })
  .help()
  .alias('help', 'h')
  .argv;

// Helper function to replace placeholders in the payload template
// Now handles data extracted from previous requests in the sequence for the same row
function replacePlaceholders(template, rowData, extractedData = {}) {
  let result = JSON.parse(JSON.stringify(template)); // Deep clone the template

  function traverse(obj) {
    for (let key in obj) {
      if (typeof obj[key] === 'object' && obj[key] !== null) {
        traverse(obj[key]);
      } else if (typeof obj[key] === 'string') {
        if (obj[key].startsWith('$')) {
          const placeholderName = obj[key].substring(1); // Name without $

          // Handle nested paths in extracted data
          if (placeholderName.includes('.')) {
            const pathParts = placeholderName.split('.');
            let value = extractedData;
            for (const part of pathParts) {
              if (value === undefined || value === null) break;
              value = value[part];
            }
            if (value !== undefined && value !== null) {
              obj[key] = value;
              continue;
            }
          }

          // Prioritize extracted data, then CSV data
          if (extractedData[placeholderName] !== undefined) {
            obj[key] = extractedData[placeholderName];
          } else if (rowData[placeholderName] !== undefined) {
            const value = rowData[placeholderName];
            // --- Special handling for 'offeringProducts' column ---
            if (placeholderName === 'offeringProducts') {
              if (typeof value === 'string' && value.trim() !== '') {
                let jsonString = value.trim();
                if (!jsonString.startsWith('[') || !jsonString.endsWith(']')) {
                  jsonString = '[' + jsonString + ']';
                }
                try {
                  obj[key] = JSON.parse(jsonString);
                } catch (parseError) {
                  console.warn(`[Row ${rowData.rowNumber || 'unknown'}] Failed to parse wrapped JSON for column '${placeholderName}': ${jsonString}. Error: ${parseError.message}. Setting field to null.`);
                  obj[key] = null;
                }
              } else {
                obj[key] = null;
              }
            }
            // --- Generic handling for all other columns ---
            else {
              if (value === 'null' || value === '') {
                obj[key] = null;
              } else if (value === 'true') {
                obj[key] = true;
              } else if (value === 'false') {
                obj[key] = false;
              } else if (!isNaN(Number(value)) && value.trim() !== '') {
                obj[key] = Number(value);
              } else {
                obj[key] = value;
              }
            }
          }
        }
      }
    }
  }

  traverse(result);
  return result;
}

// Helper function to replace placeholders (e.g., $columnName or $extractedField) in the URL template
function replaceUrlPlaceholders(urlTemplate, dataContext) { // dataContext includes both rowData and extractedData
  return urlTemplate.replace(/(?<!\$)\$([a-zA-Z0-9_]+)/g, (match, placeholderName) => {
    if (dataContext[placeholderName] !== undefined && dataContext[placeholderName] !== null) {
      return encodeURIComponent(dataContext[placeholderName]);
    } else {
      console.warn(`[Row ${dataContext.rowNumber || 'unknown'}] URL Placeholder Warning: Field '${placeholderName}' for placeholder '$${placeholderName}' not found in CSV row or extracted data. Placeholder left unchanged in URL.`);
      return match;
    }
  });
}

// Sleep function
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Create a single readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Helper function for interactive prompt
function askQuestion(query) {
  return new Promise(resolve => {
    rl.question(query, ans => {
      resolve(ans);
    });
  });
}

// --- Function to generate config --- (Remains largely the same, generates a basic single-request config)
async function generateConfig(csvPath, outputConfigPath) {
  console.log(`Generating basic config from headers in ${csvPath}...`);
  console.log(`Output file will be: ${outputConfigPath}`);
  const outputDir = path.dirname(outputConfigPath);
  try {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
      console.log(`Created directory: ${outputDir}`);
    }
  } catch (err) {
    return Promise.reject(new Error(`Failed to create output directory ${outputDir}: ${err.message}`));
  }

  return new Promise((resolve, reject) => {
    let headersFound = false;
    const stream = fs.createReadStream(path.resolve(csvPath))
      .on('error', (error) => {
        console.error(`Error opening CSV file ${csvPath}:`, error);
        reject(new Error(`Error opening CSV file: ${error.message}`));
      })
      .pipe(csv())
      .on('headers', (headerList) => {
        headersFound = true;
        if (!stream.destroyed) { stream.destroy(); }
        console.log('Headers found:', headerList);
        const payloadTemplate = {};
        headerList.forEach(header => {
          if (typeof header === 'string' && header.trim() !== '') {
              payloadTemplate[header.trim()] = `$${header.trim()}`;
          } else {
              console.warn(`Skipping invalid or empty header: ${header}`);
          }
        });

        // Generate a basic single-request structure or a multi-request structure hint
        const configData = {
          // Hint for multi-request structure:
          // requests: [
          //   {
          //     name: "Request 1",
               endpoint: "", // Placeholder - MUST BE EDITED
               method: "POST", // Default
               payloadTemplate: payloadTemplate
          //   }
          // ]
          // Or for single request (legacy):
          // endpoint: "",
          // method: "POST",
          // payloadTemplate: payloadTemplate
        };

        fs.writeFile(path.resolve(outputConfigPath), JSON.stringify(configData, null, 2), (err) => {
          if (err) {
            console.error(`Failed to write config file: ${outputConfigPath}`, err);
            return reject(new Error(`Failed to write config file: ${err.message}`));
          }
          console.log(`Basic configuration file generated successfully: ${outputConfigPath}`);
          console.log("NOTE: You MUST edit this file to set the correct 'endpoint' and potentially structure it as a multi-request sequence using the 'requests' array.");
          resolve();
        });
      })
      .on('error', (error) => {
        console.error(`Error parsing CSV file ${csvPath}:`, error);
        if (!headersFound) { reject(new Error(`Error parsing CSV file: ${error.message}`)); }
      })
      .on('close', () => {
          if (!headersFound) {
              console.error(`CSV stream closed before headers could be read (file might be empty or invalid): ${csvPath}`);
              reject(new Error(`Could not read headers from CSV (file empty or invalid?): ${csvPath}`));
          }
      })
      .on('data', () => {
          console.warn("CSV data processing unexpectedly continued after headers.");
          if (!stream.destroyed) { stream.destroy(); }
      });
  });
}

function evaluateCondition(condition, extractedData) {
  if (!condition) return true; // No condition means always run
  
  if (condition.type === 'comparison') {
    let left = condition.left;
    let right = condition.right;
    
    // Replace variables with their values
    if (typeof left === 'string' && left.startsWith('$')) {
      left = extractedData[left.substring(1)];
    }
    if (typeof right === 'string' && right.startsWith('$')) {
      right = extractedData[right.substring(1)];
    }
    
    // Convert to numbers if possible
    if (!isNaN(left)) left = Number(left);
    if (!isNaN(right)) right = Number(right);
    
    console.log(`Evaluating condition: ${JSON.stringify(condition)}`);
    console.log(`Left value: ${left}, Right value: ${right}`);
    
    switch (condition.operator) {
      case '>': return left > right;
      case '>=': return left >= right;
      case '<': return left < right;
      case '<=': return left <= right;
      case '==': return left == right;
      case '===': return left === right;
      case '!=': return left != right;
      case '!==': return left !== right;
      default: return true;
    }
  }
  
  return true; // Unknown condition type, run by default
}

// --- Process CSV function (Refactored for single config file with 'requests' array) ---
async function processCSV() {
  const csvPath = path.resolve(argv.csv);
  const configPath = argv.config ? path.resolve(argv.config) : null;
  const loopCsvPath = argv.loopCsv ? path.resolve(argv.loopCsv) : null;
  
  // Read config file
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    console.error('Error reading config file:', error);
    process.exit(1);
  }

  // Read loop CSV if specified
  let loopData = [];
  if (loopCsvPath) {
    try {
      loopData = await new Promise((resolve, reject) => {
        const data = [];
        fs.createReadStream(loopCsvPath)
          .pipe(csv())
          .on('data', (row) => data.push(row))
          .on('end', () => resolve(data))
          .on('error', reject);
      });
    } catch (error) {
      console.error('Error reading loop CSV file:', error);
      process.exit(1);
    }
  }

  // Process main CSV
  const results = [];
  let rowNumber = 0;

  return new Promise((resolve, reject) => {
    fs.createReadStream(csvPath)
      .pipe(csv())
      .on('data', async (row) => {
        rowNumber++;
        row.rowNumber = rowNumber;
        console.log(`\nProcessing row ${rowNumber}:`, row);
        
        try {
          let extractedData = {};
          
          // Process each request in sequence
          for (const request of config.requests) {
            // Check condition before processing request
            const conditionResult = evaluateCondition(request.condition, extractedData);
            console.log(`Condition result for ${request.name}: ${conditionResult}`);
            
            if (!conditionResult) {
              console.log(`Skipping ${request.name} - condition not met`);
              continue;
            }

            if (request.loopOver) {
              console.log(`Processing loop request: ${request.name}`);
              // Process loop CSV rows for this request
              for (const loopRow of loopData) {
                try {
                  const payload = replacePlaceholders(request.payloadTemplate, loopRow, extractedData);
                  const url = replaceUrlPlaceholders(request.endpoint, { ...loopRow, ...extractedData });

                  console.log(`Sending request to ${url}`);
                  console.log('Payload:', JSON.stringify(payload, null, 2));

                  if (argv.interactive) {
                    const proceed = await askQuestion(`Process ${request.name} for ${loopRow.contactName}? (y/n): `);
                    if (proceed.toLowerCase() !== 'y') continue;
                  }

                  const response = await axios({
                    method: request.method,
                    url: url,
                    data: payload,
                    headers: {
                      'Authorization': `Bearer ${argv.apikey}`,
                      'Content-Type': 'application/json'
                    }
                  });

                  console.log(`\nResponse from ${request.name}:`);
                  console.log(`Status Code: ${response.status} ${response.statusText}`);
                  console.log('Response Data:', JSON.stringify(response.data, null, 2));

                  if (request.extractFromResponse) {
                    if (Array.isArray(request.extractFromResponse)) {
                      for (const extract of request.extractFromResponse) {
                        const { field, jsonPath } = extract;
                        const value = jsonPath.split('.').reduce((obj, key) => obj?.[key], response.data.json || response.data);
                        extractedData[field] = value;
                        console.log(`Extracted ${field}:`, value);
                      }
                    } else {
                      const { field, jsonPath } = request.extractFromResponse;
                      const value = jsonPath.split('.').reduce((obj, key) => obj?.[key], response.data.json || response.data);
                      extractedData[field] = value;
                      console.log(`Extracted ${field}:`, value);
                    }
                  }

                  if (argv.delay > 0) {
                    await sleep(argv.delay);
                  }
                } catch (error) {
                  const statusCode = error.response?.status || 'N/A';
                  const errorMessage = error.response?.data?.message || error.message;
                  const errorResponse = error.response?.data || { message: error.message };
                  
                  console.error(`\nError in ${request.name}:`);
                  console.error(`Status Code: ${statusCode}`);
                  console.error('Error Response:', JSON.stringify(errorResponse, null, 2));
                  
                  logError(rowNumber, request.name, statusCode, JSON.stringify(errorResponse));
                  throw error;
                }
              }
            } else {
              console.log(`Processing request: ${request.name}`);
              try {
                const payload = replacePlaceholders(request.payloadTemplate, row, extractedData);
                const url = replaceUrlPlaceholders(request.endpoint, { ...row, ...extractedData });

                console.log(`Sending request to ${url}`);
                console.log('Payload:', JSON.stringify(payload, null, 2));

                if (argv.interactive) {
                  const proceed = await askQuestion(`Process ${request.name} for ${row.accountName}? (y/n): `);
                  if (proceed.toLowerCase() !== 'y') continue;
                }

                const response = await axios({
                  method: request.method,
                  url: url,
                  data: payload,
                  headers: {
                    'Authorization': `Bearer ${argv.apikey}`,
                    'Content-Type': 'application/json'
                  }
                });

                console.log(`\nResponse from ${request.name}:`);
                console.log(`Status Code: ${response.status} ${response.statusText}`);
                console.log('Response Data:', JSON.stringify(response.data, null, 2));

                if (request.extractFromResponse) {
                  if (Array.isArray(request.extractFromResponse)) {
                    for (const extract of request.extractFromResponse) {
                      const { field, jsonPath } = extract;
                      const value = jsonPath.split('.').reduce((obj, key) => obj?.[key], response.data.json || response.data);
                      extractedData[field] = value;
                      console.log(`Extracted ${field}:`, value);
                    }
                  } else {
                    const { field, jsonPath } = request.extractFromResponse;
                    const value = jsonPath.split('.').reduce((obj, key) => obj?.[key], response.data.json || response.data);
                    extractedData[field] = value;
                    console.log(`Extracted ${field}:`, value);
                  }
                }

                if (argv.delay > 0) {
                  await sleep(argv.delay);
                }
              } catch (error) {
                const statusCode = error.response?.status || 'N/A';
                const errorMessage = error.response?.data?.message || error.message;
                const errorResponse = error.response?.data || { message: error.message };
                
                console.error(`\nError in ${request.name}:`);
                console.error(`Status Code: ${statusCode}`);
                console.error('Error Response:', JSON.stringify(errorResponse, null, 2));
                
                logError(rowNumber, request.name, statusCode, JSON.stringify(errorResponse));
                throw error;
              }
            }
          }
          
          results.push({ rowNumber, success: true, extractedData });
          console.log(`Completed row ${rowNumber} successfully`);
        } catch (error) {
          results.push({ rowNumber, success: false, error: error.message });
          console.error(`Failed row ${rowNumber}:`, error.message);
        }
      })
      .on('end', () => {
        console.log('\nProcessing complete!');
        console.log('Results:', JSON.stringify(results, null, 2));
        errorLogStream.end();
        rl.close();
        resolve(results);
      })
      .on('error', (error) => {
        console.error('Error reading CSV file:', error);
        errorLogStream.end();
        rl.close();
        reject(error);
      });
  });
}

// --- Main execution logic ---
async function main() {
  if (argv.generateConfig) {
    let outputConfigPath;
    if (argv.outputConfig) {
      outputConfigPath = path.resolve(argv.outputConfig);
    } else {
      const csvBaseName = path.basename(argv.csv, path.extname(argv.csv));
      const derivedFilename = `${csvBaseName}-config.json`;
      outputConfigPath = path.resolve('mapping', derivedFilename);
    }

    if (fs.existsSync(outputConfigPath)) {
      console.error(`Error: Output config file already exists: ${outputConfigPath}`);
      console.error("Generation aborted. Use --output-config or delete the existing file.");
      process.exit(1);
    }

    try {
      await generateConfig(argv.csv, outputConfigPath);
      // Instructions updated slightly for new config format possibility
      console.log("\nConfig generation complete.");
      console.log("----------------------------------------");
      console.log("To process data:");
      console.log("1. Edit the generated file:");
      console.log(`   - Set the correct 'endpoint' and 'method'.`);
      console.log(`   - Review 'payloadTemplate'.`);
      console.log(`   - To run multiple requests sequentially, structure the file with a top-level "requests": [...] array, where each object in the array defines one request ('name', 'endpoint', 'method', 'payloadTemplate', optional 'extractFromResponse').`);
      console.log(`   File: ${outputConfigPath}`);
      console.log("2. Run the command:");
      console.log(`\n   node index.js --csv ${argv.csv} --config ${outputConfigPath} --apikey YOUR_API_KEY\n`);
      console.log("(Use --endpoint to override endpoint(s) defined in the config)");
      console.log("----------------------------------------");
      process.exit(0);
    } catch (error) {
      console.error('Exiting due to error during config generation.');
      process.exit(1);
    }
  } else {
    console.log("Starting CSV processing mode...");
    await processCSV();
  }
}

// Run the main function
main().catch(error => {
    console.error("Unhandled error in main execution:", error);
    process.exit(1);
});
