// index.js
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const axios = require('axios');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

// Command line arguments
const argv = yargs(hideBin(process.argv))
  .option('csv', {
    alias: 'c',
    description: 'Path to the CSV file',
    type: 'string',
    demandOption: true
  })
  .option('config', {
    alias: 'f',
    description: 'Path to the configuration file',
    type: 'string',
    demandOption: true
  })
  .option('apikey', {
    alias: 'k',
    description: 'API key for authentication',
    type: 'string',
    demandOption: true
  })
  .option('endpoint', {
    alias: 'e',
    description: 'API endpoint',
    type: 'string',
    demandOption: true
  })
  .option('delay', {
    alias: 'd',
    description: 'Delay between requests in milliseconds',
    type: 'number',
    default: 0
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
            // Try to convert to appropriate data type
            const value = rowData[columnName];
            if (value === 'null' || value === '') {
              obj[key] = null;
            } else if (value === 'true') {
              obj[key] = true;
            } else if (value === 'false') {
              obj[key] = false;
            } else if (!isNaN(Number(value))) {
              obj[key] = Number(value);
            } else {
              obj[key] = value;
            }
          }
        } else {
          // For strings that aren't placeholders but might contain $ in them
          // We're not doing replacement inside strings for simplicity
          // If needed, this could be added later with a different syntax
        }
      }
    }
  }
  
  traverse(result);
  return result;
}

// Sleep function for introducing delay between requests
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function processCSV() {
  try {
    // Load configuration file
    const configPath = path.resolve(argv.config);
    const configRaw = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(configRaw);
    
    if (!config.payloadTemplate) {
      throw new Error('Configuration file must contain a payloadTemplate object');
    }
    
    // Setup API client
    const apiClient = axios.create({
      baseURL: argv.endpoint,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': argv.apikey
      }
    });
    
    // Process CSV file
    const results = [];
    let processedRows = 0;
    let successfulRequests = 0;
    let failedRequests = 0;
    
    console.log(`Starting to process CSV file: ${argv.csv}`);
    console.log(`Sending requests to: ${argv.endpoint}`);
    console.log(`Delay between requests: ${argv.delay}ms`);
    
    // Create a readable stream from the CSV file
    fs.createReadStream(path.resolve(argv.csv))
      .pipe(csv())
      .on('data', (row) => {
        results.push(row);
      })
      .on('end', async () => {
        console.log(`CSV file successfully processed. Found ${results.length} rows.`);
        
        // Process each row and make API requests
        for (const row of results) {
          try {
            processedRows++;
            
            // Create payload by replacing placeholders in the template
            const payload = replacePlaceholders(config.payloadTemplate, row);
            
            console.log(`Processing row ${processedRows}/${results.length}`);
            console.log(`Sending payload: ${JSON.stringify(payload, null, 2)}`);
            
            // Send the request
            const response = await apiClient.post('', payload);
            
            console.log(`Response: ${response.status} ${response.statusText}`);
            if (response.data) {
              console.log(`Response data: ${JSON.stringify(response.data, null, 2)}`);
            }
            
            successfulRequests++;
            
            // Wait for specified delay
            if (argv.delay > 0 && processedRows < results.length) {
              await sleep(argv.delay);
            }
          } catch (error) {
            failedRequests++;
            console.error(`Error processing row ${processedRows}:`, error.message);
            if (error.response) {
              console.error(`Status: ${error.response.status}`);
              console.error(`Response data:`, error.response.data);
            }
          }
        }
        
        console.log('\nProcessing complete!');
        console.log(`Total rows processed: ${processedRows}`);
        console.log(`Successful requests: ${successfulRequests}`);
        console.log(`Failed requests: ${failedRequests}`);
      });
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

// Run the application
processCSV();
