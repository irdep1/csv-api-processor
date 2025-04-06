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
    description: 'Path to the configuration file (required unless --generate-config is used)',
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
    description: 'API endpoint (overrides endpoint in config file if provided)',
    type: 'string'
    // Requirement is now checked dynamically in processCSV
  })
  .option('delay', {
    alias: 'd',
    description: 'Delay between requests in milliseconds',
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
function replacePlaceholders(template, rowData) {
  let result = JSON.parse(JSON.stringify(template)); // Deep clone the template

  function traverse(obj) {
    for (let key in obj) {
      if (typeof obj[key] === 'object' && obj[key] !== null) {
        traverse(obj[key]);
      } else if (typeof obj[key] === 'string') {
        // Check if the string starts with $ (our placeholder indicator)
        if (obj[key].startsWith('$')) {
          const columnName = obj[key].substring(1); // Remove the $ prefix
          if (rowData[columnName] !== undefined) {
            const value = rowData[columnName];

            // --- Special handling for 'offeringProducts' column ---
            if (columnName === 'offeringProducts') {
                if (typeof value === 'string' && value.trim() !== '') {
                    let jsonString = value.trim();
                    if (!jsonString.startsWith('[') || !jsonString.endsWith(']')) {
                        jsonString = '[' + jsonString + ']'; // Wrap with brackets only if not already an array
                    }
                    try {
                        obj[key] = JSON.parse(jsonString); // Parse the string
                    } catch (parseError) {
                        console.warn(`[Row ${rowData.rowNumber || 'unknown'}] Failed to parse wrapped JSON for column '${columnName}': ${jsonString}. Error: ${parseError.message}. Setting field to null.`);
                        obj[key] = null; // Set to null if parsing fails
                    }
                } else {
                    // If CSV value is empty, null, or not a string, set payload field to null
                    obj[key] = null; // Or potentially an empty array [] if the API prefers
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
                 } else if (!isNaN(Number(value)) && value.trim() !== '') { // Ensure non-empty string before Number conversion
                    obj[key] = Number(value);
                 } else {
                    obj[key] = value; // Keep as string if not convertible
                 }
            }
          } else {
             // If placeholder exists but column doesn't, keep the placeholder string
             // console.warn(`[Row ${rowData.rowNumber || 'unknown'}] Column '${columnName}' referenced in template but not found in CSV row.`);
             // obj[key] = null; // Alternative: set to null
          }
        }
      }
    }
  }

  traverse(result);
  return result;
}

// Helper function to replace placeholders (e.g., $columnName) in the URL template
function replaceUrlPlaceholders(urlTemplate, rowData) {
  // Regex to find $placeholder (ensuring it's not preceded by another $ to avoid issues like $$var)
  // It looks for a $ followed by one or more word characters (letters, numbers, underscore)
  return urlTemplate.replace(/(?<!\$)\$([a-zA-Z0-9_]+)/g, (match, columnName) => {
    if (rowData[columnName] !== undefined && rowData[columnName] !== null) {
      // URL encode the value to handle special characters safely in the path
      return encodeURIComponent(rowData[columnName]);
    } else {
      console.warn(`[Row ${rowData.rowNumber || 'unknown'}] URL Placeholder Warning: Column '${columnName}' for placeholder '$${columnName}' not found in CSV row or value is null/undefined. Placeholder left unchanged in URL.`);
      return match; // Keep the original placeholder (e.g., $param) if column not found or value is null/undefined
    }
  });
}

// Sleep function for introducing delay between requests
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
// --- New function to generate config ---
// Assumes outputConfigPath has been validated (doesn't exist) by the caller
async function generateConfig(csvPath, outputConfigPath) {
  console.log(`Generating config from headers in ${csvPath}...`);
  console.log(`Output file will be: ${outputConfigPath}`);

  // Ensure the output directory exists
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
    let headersFound = false; // Flag to track if headers event was emitted
    const stream = fs.createReadStream(path.resolve(csvPath))
      .on('error', (error) => { // Handle stream creation errors early
        console.error(`Error opening CSV file ${csvPath}:`, error);
        reject(new Error(`Error opening CSV file: ${error.message}`));
      })
      .pipe(csv())
      .on('headers', (headerList) => {
        headersFound = true;
        // Ensure stream is destroyed to prevent reading data rows
        if (!stream.destroyed) {
            stream.destroy();
        }

        console.log('Headers found:', headerList);
        const payloadTemplate = {};
        headerList.forEach(header => {
          // Ensure header is a non-empty string before using it as a key
          if (typeof header === 'string' && header.trim() !== '') {
              payloadTemplate[header.trim()] = `$${header.trim()}`; // Use $ prefix convention, trim whitespace
          } else {
              console.warn(`Skipping invalid or empty header: ${header}`);
          }
        });

        const configData = {
          endpoint: "", // Placeholder for endpoint
          method: "POST", // Default HTTP method
          payloadTemplate: payloadTemplate
        };

        // Write the config file
        fs.writeFile(path.resolve(outputConfigPath), JSON.stringify(configData, null, 2), (err) => {
          if (err) {
            console.error(`Failed to write config file: ${outputConfigPath}`, err);
            return reject(new Error(`Failed to write config file: ${err.message}`));
          }
          console.log(`Configuration file generated successfully: ${outputConfigPath}`);
          resolve();
        });
      })
      .on('error', (error) => { // Handle errors during CSV parsing
        console.error(`Error parsing CSV file ${csvPath}:`, error);
        // Ensure rejection if headers haven't been processed yet
        if (!headersFound) {
            reject(new Error(`Error parsing CSV file: ${error.message}`));
        }
        // If headers were processed but write failed, the writeFile callback handles rejection.
      })
      .on('close', () => {
          // This event fires when the stream is fully closed (e.g., after destroy() or EOF)
          // If headers were never found (e.g., empty file), reject the promise.
          if (!headersFound) {
              // Check if already rejected by an error handler
              // This check might be tricky depending on event order, but aims to prevent double rejection.
              // A simpler approach might be to rely solely on the 'error' handlers.
              // Let's refine this: if 'close' happens and headersFound is false, it implies an issue
              // like an empty file or immediate error not caught by 'error' listeners above.
              console.error(`CSV stream closed before headers could be read (file might be empty or invalid): ${csvPath}`);
              // Attempt rejection only if not already handled
              // Note: This logic can be complex; robust error handling might need state flags.
              // For now, let's assume 'error' events are the primary rejection path.
              // If the file is just empty, 'headers' won't fire, 'end'/'close' will, and we need to reject.
              reject(new Error(`Could not read headers from CSV (file empty or invalid?): ${csvPath}`));
          }
      })
      // No 'data' listener needed here as we destroy the stream after headers.
      .on('data', () => {
          // This should ideally not be reached if stream.destroy() works promptly.
          // If it does, it means data is being processed unnecessarily.
          console.warn("CSV data processing unexpectedly continued after headers.");
          if (!stream.destroyed) {
              stream.destroy(); // Attempt destroy again
          }
      });
  });
}


// --- Existing processCSV function (minor adjustments for clarity) ---
async function processCSV() {
  try {
    // Load configuration file using the provided path
    const configPath = path.resolve(argv.config);
    console.log(`Loading configuration from: ${configPath}`);
    const configRaw = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(configRaw);

    if (!config.payloadTemplate) {
      throw new Error('Configuration file must contain a payloadTemplate object');
    }

    // Determine the API endpoint *template* to use
    let apiEndpointTemplate;
    if (argv.endpoint) {
      // Command-line argument takes precedence
      apiEndpointTemplate = argv.endpoint;
      console.log(`Using API endpoint template from command line: ${apiEndpointTemplate}`);
    } else if (config.endpoint && typeof config.endpoint === 'string' && config.endpoint.trim() !== '') {
      // Use endpoint template from config file if command-line arg is missing and config has it
      apiEndpointTemplate = config.endpoint;
      console.log(`Using API endpoint template from config file: ${apiEndpointTemplate}`);
    } else {
      // No endpoint template found in command-line args or config file
      throw new Error('API endpoint template must be provided either via the --endpoint command-line argument or within the "endpoint" field in the config file. Use $columnName for placeholders.');
    }

    // Determine the HTTP method (default to POST)
    const httpMethod = (config.method && ['POST', 'PUT'].includes(config.method.toUpperCase()))
      ? config.method.toUpperCase()
      : 'POST';
    console.log(`Using HTTP method: ${httpMethod}`);

    // Setup API client (without baseURL, as it's dynamic per request)
    const apiClient = axios.create({
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': argv.apikey // Use API key from arguments
      }
      // timeout: 10000, // Optional: Add a request timeout
    });

    // Process CSV file
    const results = [];
    let processedRows = 0;
    let successfulRequests = 0;
    let failedRequests = 0;

    console.log(`Starting to process CSV file: ${argv.csv}`);
    console.log(`Delay between requests: ${argv.delay}ms`);

    // Create a readable stream from the CSV file
    const csvStream = fs.createReadStream(path.resolve(argv.csv))
      .pipe(csv())
      .on('data', (row) => {
        results.push(row);
      })
      .on('end', async () => {
        console.log(`CSV file successfully read. Found ${results.length} rows.`);

        if (results.length === 0) {
            console.log("No data rows found in CSV to process.");
            return; // Exit if no data
        }

        // Process each row and make API requests
        for (const row of results) {
          processedRows++;
          try {
            // Add row number for better logging in helper functions
            row.rowNumber = processedRows;

            // Create payload by replacing placeholders in the template
            const payload = replacePlaceholders(config.payloadTemplate, row);

            // Create final URL by replacing placeholders in the template
            const finalUrl = replaceUrlPlaceholders(apiEndpointTemplate, row);

            console.log(`\n[Row ${processedRows}/${results.length}]`);
            // console.log(`Raw data: ${JSON.stringify(row)}`); // Optional: for debugging raw row data
            console.log(`Target URL: ${httpMethod} ${finalUrl}`);
            console.log(`Sending payload: ${JSON.stringify(payload, null, 2)}`);

            // Send the request
            const response = await apiClient.request({
              method: httpMethod,
              url: finalUrl, // Use the dynamically generated URL
              data: payload
            });

            console.log(`Response Status: ${response.status} ${response.statusText}`);
            // Optionally log response data if needed
            // if (response.data) {
            //   console.log(`Response data: ${JSON.stringify(response.data, null, 2)}`);
            // }

            successfulRequests++;

            // Wait for specified delay if not the last row
            if (argv.delay > 0 && processedRows < results.length) {
              console.log(`Waiting ${argv.delay}ms...`);
              await sleep(argv.delay);
            }
          } catch (error) {
            failedRequests++;
            console.error(`Error processing row ${processedRows}:`, error.message);
            if (error.response) {
              // Log detailed error response if available
              console.error(`API Error Status: ${error.response.status}`);
              console.error(`API Error Response:`, JSON.stringify(error.response.data, null, 2));
            } else if (error.request) {
              // The request was made but no response was received
              console.error('API Error: No response received from server.');
            } else {
              // Something happened in setting up the request that triggered an Error
              console.error('API Error: Request setup failed.', error.message);
            }
            // Optional: Decide whether to continue processing next rows or stop on error
          }

          // --- Interactive Mode Check ---
          if (argv.interactive && processedRows < results.length) {
            const answer = await askQuestion(`\nProcessed row ${processedRows}/${results.length}. Continue? (y/n): `);
            if (answer.toLowerCase() === 'n') {
              console.log("Stopping interactive processing.");
              break; // Exit the loop
            }
          }
        }

        console.log('\n--- Processing Summary ---');
        console.log(`Total rows processed: ${processedRows}`);
        console.log(`Successful requests: ${successfulRequests}`);
        console.log(`Failed requests: ${failedRequests}`);
        console.log('--------------------------');
      })
      .on('error', (error) => {
          // Handle errors during CSV parsing itself
          console.error(`Error reading or parsing CSV file: ${error.message}`);
          // Ensure process exits on stream error if it hasn't already
          if (!process.exitCode) process.exitCode = 1;
      });

  } catch (error) {
    // Catch errors from initial setup (reading config, etc.)
    console.error('Fatal Error:', error.message);
    process.exit(1);
  }
}

// --- Main execution logic ---
async function main() {
  if (argv.generateConfig) {
    let outputConfigPath;

    // Determine the output path
    if (argv.outputConfig) {
      // User provided an explicit path
      outputConfigPath = path.resolve(argv.outputConfig);
    } else {
      // Derive path from CSV name, place in 'mapping' directory
      const csvBaseName = path.basename(argv.csv, path.extname(argv.csv)); // Get filename without extension
      const derivedFilename = `${csvBaseName}-config.json`;
      outputConfigPath = path.resolve('mapping', derivedFilename); // Place in mapping/ subdir relative to CWD
    }

    // Check if the output file already exists
    if (fs.existsSync(outputConfigPath)) {
      console.error(`Error: Output config file already exists: ${outputConfigPath}`);
      console.error("Generation aborted to prevent overwriting. Use --output-config with a different name or delete the existing file.");
      process.exit(1); // Exit with error code
    }

    // Proceed with generation if file doesn't exist
    try {
      // generateConfig now handles directory creation internally
      await generateConfig(argv.csv, outputConfigPath);
      console.log("\nConfig generation complete.");
      console.log("----------------------------------------");
      console.log("To process the data using this configuration:");
      console.log("1. Edit the generated file:");
      console.log(`   - Set the correct 'endpoint' template. Use $columnName syntax for URL path parameters (e.g., "https://api.example.com/items/$itemId"). Values will be URL-encoded.`);
      console.log(`   - Optionally change 'method' (default is POST, PUT is also supported).`);
      console.log(`   - Review the 'payloadTemplate' to ensure it matches your API structure.`);
      console.log(`   File: ${outputConfigPath}`);
      console.log("2. Run the command, replacing YOUR_API_KEY:");
      console.log(`\n   node index.js --csv ${argv.csv} --config ${outputConfigPath} --apikey YOUR_API_KEY\n`);
      console.log("(You can override the config's endpoint template with the --endpoint argument if needed)");
      console.log("----------------------------------------");
      process.exit(0); // Exit successfully after generating config
    } catch (error) {
      // Error message is logged within generateConfig or its callees
      console.error('Exiting due to error during config generation.');
      process.exit(1); // Exit with error code
    }
  } else {
    // Run the original processing logic if not generating config
    console.log("Starting CSV processing mode...");
    await processCSV();
    // processCSV handles its own errors and summary logging.
    // It might exit internally on fatal errors, or complete naturally.
  }
}

// Run the main function
main().catch(error => {
    // Catch any unhandled promise rejections from main/processCSV/generateConfig
    console.error("Unhandled error in main execution:", error);
    process.exit(1);
});
