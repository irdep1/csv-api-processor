// index.js
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const axios = require('axios');
const yargs = require('yargs');

// --- Helper functions ---
function readCsv(filePath) {
  return new Promise((resolve, reject) => {
    const results = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => resolve(results))
      .on('error', reject);
  });
}

function buildPayload(template, data) {
  const payload = {};
  for (const [key, value] of Object.entries(template)) {
    if (typeof value === 'string' && value.startsWith('$')) {
      const fieldName = value.substring(1);
      payload[key] = data[fieldName];
    } else {
      payload[key] = value;
    }
  }
  return payload;
}

function evaluateCondition(condition, row) {
  const { field, operator, value } = condition;
  const fieldValue = row[field];
  
  switch (operator) {
    case '>': return Number(fieldValue) > Number(value);
    case '<': return Number(fieldValue) < Number(value);
    case '>=': return Number(fieldValue) >= Number(value);
    case '<=': return Number(fieldValue) <= Number(value);
    case '==': return fieldValue == value;
    case '!=': return fieldValue != value;
    case 'exists': return (value === true) ? fieldValue !== undefined : fieldValue === undefined;
    default: return false;
  }
}

function extractFields(response, fields, extractedData) {
  for (const field of fields) {
    const value = field.jsonPath.split('.').reduce((obj, key) => obj?.[key], response);
    if (value !== undefined) {
      extractedData[field.field] = value;
    }
  }
}

async function makeRequest(request, payload, apiKey) {
  try {
    const response = await axios({
      method: request.method,
      url: request.endpoint,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      data: payload
    });
    return response.data;
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message);
  }
}

async function processRow(row, rowNumber, config, apiKey, loopCsvPath) {
  const results = {
    success: true,
    errors: [],
    extractedData: {}
  };

  for (const request of config.requests) {
    try {
      if (request.condition) {
        const conditionMet = evaluateCondition(request.condition, row);
        if (!conditionMet) {
          console.log(`[Row ${rowNumber}] ${request.name} - Condition not met: ${request.condition.field} ${request.condition.operator} ${request.condition.value}`);
          continue;
        }
        console.log(`[Row ${rowNumber}] ${request.name} - Condition met: ${request.condition.field} ${request.condition.operator} ${request.condition.value}`);
      }

      if (request.loopCsv) {
        const loopCsvData = await readCsv(loopCsvPath);
        for (const loopRow of loopCsvData) {
          const payload = buildPayload(request.payloadTemplate, { ...row, ...loopRow });
          const payloadStr = JSON.stringify(payload).substring(0, 100) + '...';
          console.log(`[Row ${rowNumber}] ${request.name} - Request: ${request.method} ${request.endpoint} ${payloadStr}`);
          const response = await makeRequest(request, payload, apiKey);
          const responseStr = JSON.stringify(response).substring(0, 100) + '...';
          console.log(`[Row ${rowNumber}] ${request.name} - Response: ${response.status || '200'} ${responseStr}`);
          if (request.extractFromResponse) {
            extractFields(response, request.extractFromResponse, results.extractedData);
            const extractedStr = request.extractFromResponse.map(f => `${f.field}=${results.extractedData[f.field]}`).join(', ');
            console.log(`[Row ${rowNumber}] ${request.name} - Extracted: ${extractedStr}`);
          }
        }
      } else {
        const payload = buildPayload(request.payloadTemplate, row);
        const payloadStr = JSON.stringify(payload).substring(0, 100) + '...';
        console.log(`[Row ${rowNumber}] ${request.name} - Request: ${request.method} ${request.endpoint} ${payloadStr}`);
        const response = await makeRequest(request, payload, apiKey);
        const responseStr = JSON.stringify(response).substring(0, 100) + '...';
        console.log(`[Row ${rowNumber}] ${request.name} - Response: ${response.status || '200'} ${responseStr}`);
        if (request.extractFromResponse) {
          extractFields(response, request.extractFromResponse, results.extractedData);
          const extractedStr = request.extractFromResponse.map(f => `${f.field}=${results.extractedData[f.field]}`).join(', ');
          console.log(`[Row ${rowNumber}] ${request.name} - Extracted: ${extractedStr}`);
        }
      }
    } catch (error) {
      results.success = false;
      results.errors.push({
        request: request.name,
        error: error.message
      });
      console.log(`[Row ${rowNumber}] ${request.name} - Error: ${error.message}`);
    }
  }

  return results;
}

// --- Main execution logic ---
async function main() {
  const argv = yargs
    .option('csv', {
      describe: 'Path to the CSV file',
      type: 'string',
      demandOption: true
    })
    .option('config', {
      describe: 'Path to the config file',
      type: 'string',
      demandOption: true
    })
    .option('apikey', {
      describe: 'API key for authentication',
      type: 'string',
      demandOption: true
    })
    .option('loop-csv', {
      describe: 'Path to the loop CSV file',
      type: 'string'
    })
    .help()
    .argv;

  try {
    const config = JSON.parse(fs.readFileSync(argv.config, 'utf8'));
    const csvData = await readCsv(argv.csv);
    const results = [];

    for (let i = 0; i < csvData.length; i++) {
      const row = csvData[i];
      const rowResults = await processRow(row, i + 1, config, argv.apikey, argv.loopCsv);
      results.push(rowResults);
    }

    const successCount = results.filter(r => r.success).length;
    const errorCount = results.filter(r => !r.success).length;
    console.log(`\nProcessing complete: ${successCount} successful, ${errorCount} failed`);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
