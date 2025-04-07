// index.js
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const axios = require('axios');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const readline = require('readline'); // Import readline for interactive mode

// Command line arguments
const argv = yargs(hideBin(process.argv))
  .option('csv', {
    alias: 'c',
    description: 'Path to the CSV file',
    type: 'string',
    demandOption: true // Always required
  })
  .option('config', {
    alias: 'f',
    description: 'Path to the JSON configuration file. Supports single request (legacy) or multi-request sequence via "requests" array.',
    type: 'string'
    // demandOption removed, handled by .check()
  })
  .option('apikey', {
    alias: 'k',
    description: 'API key for authentication (required unless --generate-config is used)',
    type: 'string'
    // demandOption removed, handled by .check()
  })
  .option('endpoint', {
    alias: 'e',
    description: 'API endpoint URL template. Overrides endpoint(s) defined in the config file if provided.',
    type: 'string'
    // Requirement is now checked dynamically in processCSV
  })
  .option('delay', {
    alias: 'd',
    description: 'Delay between processing each ROW in milliseconds', // Updated description
    type: 'number',
    default: 0
  })
  .option('generate-config', { // <-- New flag
    description: 'Generate a config file from CSV headers and exit',
    type: 'boolean',
    default: false
  })
  .option('output-config', { // <-- Option for explicit output filename
      description: 'Explicit filename for the generated config file (optional)',
      type: 'string'
      // Default is now derived from --csv if this is omitted
  })
  .option('interactive', { // <-- New flag for interactive mode
      description: 'Run in interactive mode, prompting after each row',
      type: 'boolean',
      default: false
  })
  // Check for conditional requirements
  .check((argv) => {
      if (!argv.generateConfig) {
          // If not generating config, the standard options are required
          if (argv.config === undefined) throw new Error("Missing required argument: --config (-f)");
          if (argv.apikey === undefined) throw new Error("Missing required argument: --apikey (-k)");
          // Endpoint requirement is now checked within processCSV based on config content
      }
      // No need to check for --csv here as demandOption: true handles it
      return true; // Indicate checks passed
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

// Helper function for interactive prompt
function askQuestion(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans);
    }))
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

// --- Process CSV function (Refactored for single config file with 'requests' array) ---
async function processCSV() {
  try {
    // Load the single configuration file
    const configPath = path.resolve(argv.config);
    console.log(`Loading configuration from: ${configPath}`);
    let configRaw;
    try {
        configRaw = fs.readFileSync(configPath, 'utf8');
    } catch (readError) {
        throw new Error(`Error reading configuration file: ${readError.message}`);
    }
    const config = JSON.parse(configRaw);

    // Determine if we are in multi-request mode or single-request (legacy) mode
    const isMultiRequestMode = Array.isArray(config.requests) && config.requests.length > 0;

    // Validate config structure
    if (isMultiRequestMode) {
        console.log("Multi-request mode detected.");
        if (config.requests.some(req => !req.payloadTemplate || !req.endpoint)) {
            throw new Error('Each request object in the "requests" array must contain at least "endpoint" and "payloadTemplate".');
        }
    } else if (config.payloadTemplate && config.endpoint) {
        console.log("Single-request (legacy) mode detected.");
    } else {
        throw new Error('Configuration file must contain a valid "endpoint" and "payloadTemplate" (for single request mode) or a valid "requests" array (for multi-request mode).');
    }

    // Setup API client
    const apiClient = axios.create({
      headers: { 'Content-Type': 'application/json', 'x-api-key': argv.apikey },
      // timeout: 10000, // Optional
    });

    // Process CSV file
    const results = [];
    let processedRows = 0;
    let successfulRows = 0; // Track rows where all requests succeeded
    let failedRows = 0;     // Track rows where at least one request failed

    console.log(`Starting to process CSV file: ${argv.csv}`);
    console.log(`Delay between processing each ROW: ${argv.delay}ms`);

    // Debugging: Log the value of argv.csv
    console.log(`CSV file path: ${argv.csv}`);

    let csvPath = "";
    if (typeof argv === 'object' && argv !== null && argv.hasOwnProperty('csv')) {
        let rawCsvPath = String(argv['csv']).trim(); // Convert to string and trim whitespace
        csvPath = path.resolve(rawCsvPath.replace(/,+$/, '')); // Remove trailing commas and resolve the CSV path
    } else {
        throw new Error("Failed to parse CSV file path from command line arguments.");
    }
    const csvStream = fs.createReadStream(csvPath)
      .pipe(csv())
      .on('data', (row) => { results.push(row); })
      .on('end', async () => {
        console.log(`CSV file successfully read. Found ${results.length} rows.`);
        if (results.length === 0) { console.log("No data rows found."); return; }

        // Process each row
        for (const row of results) {
          processedRows++;
          let rowFailed = false;
          let extractedDataForRow = {}; // Store extracted data for this row's sequence

          console.log(`\n[Row ${processedRows}/${results.length}] Processing...`);
          row.rowNumber = processedRows; // Add row number for logging context

          // Determine the list of requests to process for this row
          const requestsToProcess = isMultiRequestMode ? config.requests : [config]; // Use requests array or wrap single config

          try {
            // Iterate through the sequence of requests for the current row
            for (let i = 0; i < requestsToProcess.length; i++) {
              const currentRequestConfig = requestsToProcess[i];
              const requestName = currentRequestConfig.name || `Request #${i + 1}`;

              console.log(`--- ${requestName} ---`);

              // Determine endpoint and method for this specific request
              let endpointTemplate = argv.endpoint || currentRequestConfig.endpoint; // Command-line override takes precedence
              const httpMethod = (currentRequestConfig.method && ['POST', 'PUT', 'GET', 'DELETE', 'PATCH'].includes(currentRequestConfig.method.toUpperCase()))
                ? currentRequestConfig.method.toUpperCase()
                : 'POST'; // Default to POST

              if (!endpointTemplate || typeof endpointTemplate !== 'string' || endpointTemplate.trim() === '') {
                  throw new Error(`Missing or invalid "endpoint" for ${requestName} in config. Please ensure it is a string.`);
              }
              if (argv.endpoint) { console.log(`Using endpoint from command line override: ${endpointTemplate}`); }
              else { console.log(`Using endpoint from config: ${endpointTemplate}`); }

              if (typeof endpointTemplate !== 'string') {
                  throw new Error(`The endpoint for ${requestName} must be a string.`);
              }
              console.log(`Using HTTP method: ${httpMethod}`);

              // Create the data context for placeholder replacement (CSV row + data extracted so far for this row)
              const dataContext = { ...row, ...extractedDataForRow };

              // Replace placeholders in endpoint and payload
              const finalUrl = replaceUrlPlaceholders(endpointTemplate, dataContext);
              const payload = replacePlaceholders(currentRequestConfig.payloadTemplate, row, extractedDataForRow); // Pass row and extracted separately for clarity in function

              console.log(`Target URL: ${httpMethod} ${finalUrl}`);
              if (httpMethod !== 'GET' && httpMethod !== 'DELETE') {
                  console.log(`Sending payload: ${JSON.stringify(payload, null, 2)}`);
              }

              // Make the API request
              const response = await apiClient.request({
                method: httpMethod,
                url: finalUrl,
                data: (httpMethod !== 'GET' && httpMethod !== 'DELETE') ? payload : undefined, // Don't send body for GET/DELETE
              });

              console.log(`Response Status: ${response.status} ${response.statusText}`);
              // if (response.data) { console.log(`Response data: ${JSON.stringify(response.data, null, 2)}`); } // Optional logging

              // Extract data if configured for this request
              if (currentRequestConfig.extractFromResponse) {
                const { field, jsonPath } = currentRequestConfig.extractFromResponse;
                if (field && jsonPath) {
                  try {
                    // Basic JSON path extraction (handles simple dot notation)
                    let valueToExtract = response.data;
                    const pathParts = jsonPath.split('.');
                    for (const part of pathParts) {
                        if (valueToExtract === undefined || valueToExtract === null) {
                            console.warn(`[Row ${row.rowNumber}] Path part "${part}" not found in response data`);
                            valueToExtract = null;
                            break;
                        }
                        valueToExtract = valueToExtract[part];
                    }

                    if (valueToExtract !== undefined && valueToExtract !== null) {
                        extractedDataForRow[field] = valueToExtract;
                        console.log(`Extracted "${field}": ${JSON.stringify(valueToExtract)}`);
                    } else {
                        console.warn(`[Row ${row.rowNumber}] Could not extract "${field}" using path "${jsonPath}". Value not found or path invalid.`);
                        extractedDataForRow[field] = null;
                    }
                  } catch (extractError) {
                    console.error(`[Row ${row.rowNumber}] Error extracting data for field "${field}" using path "${jsonPath}": ${extractError.message}`);
                    extractedDataForRow[field] = null;
                  }
                } else {
                  console.warn(`[Row ${row.rowNumber}] Incomplete "extractFromResponse" configuration for ${requestName}: Missing "field" or "jsonPath".`);
                }
              }
            } // End loop through requests for this row

            // If loop completed without error for this row
            successfulRows++;

          } catch (error) {
            rowFailed = true;
            failedRows++;
            console.error(`Error processing row ${processedRows} during ${error.requestName || 'a request'}:`, error.message); // Add request name if possible
            if (error.response) {
              console.error(`API Error Status: ${error.response.status}`);
              console.error(`API Error Response:`, JSON.stringify(error.response.data, null, 2));
            } else if (error.request) {
              console.error('API Error: No response received from server.');
            } else {
              console.error('API Error: Request setup failed or other error.', error.message);
            }
            // Stop processing further requests for this row on error
            // (Currently continues to next row)
          }

          // Wait for specified delay before processing the next row
          if (argv.delay > 0 && processedRows < results.length) {
            console.log(`Waiting ${argv.delay}ms before next row...`);
            await sleep(argv.delay);
          }

          // Interactive Mode Check
          if (argv.interactive && processedRows < results.length) {
            const answer = await askQuestion(`\nProcessed row ${processedRows}/${results.length}. ${rowFailed ? 'An error occurred.' : ''} Continue? (y/n): `);
            if (answer.toLowerCase() === 'n') {
              console.log("Stopping interactive processing.");
              break; // Exit the main row loop
            }
          }
        } // End loop through rows

        console.log('\n--- Processing Summary ---');
        console.log(`Total rows processed: ${processedRows}`);
        console.log(`Rows fully successful: ${successfulRows}`);
        console.log(`Rows with failures: ${failedRows}`);
        console.log('--------------------------');
      })
      .on('error', (error) => {
        console.error(`Error reading or parsing CSV file: ${error.message}`);
        if (!process.exitCode) process.exitCode = 1;
      });

  } catch (error) {
    console.error('Fatal Error:', error.message);
    process.exit(1);
  }
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
