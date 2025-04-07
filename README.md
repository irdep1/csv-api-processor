# CSV API Processor

A Node.js utility for processing CSV data and sending it to an API endpoint using a configurable template.

## Description

This tool reads data from a CSV file, applies it to a JSON template defined in a configuration file, and sends the resulting payloads to a specified API endpoint. It supports both single API requests per CSV row and sequential multi-step API requests where data from one response can be used in subsequent requests for the same row. It's useful for data migration, API integration, and batch processing tasks.

## Installation

```bash
# Clone the repository (if applicable)
git clone <repository-url>
cd <project-directory>

# Install dependencies
npm install
```

## Usage

Run the script with the following command-line arguments:

```bash
node index.js --csv <path-to-csv> --config <path-to-config> --apikey <your-api-key> [--endpoint <api-endpoint>] [--delay <ms>] [--interactive]
```

### Required Arguments

- `--csv` or `-c`: Path to the CSV file containing the data to process
- `--config` or `-f`: Path to the JSON configuration file. See "Configuration File" section below for format details (supports single or multi-request).
- `--apikey` or `-k`: API key for authentication.

### Optional Arguments

- `--endpoint` or `-e`: API endpoint URL template. If provided, this *overrides* any `endpoint` defined within the configuration file(s). Useful for switching environments (e.g., staging vs. production) without editing the config.
- `--delay` or `-d`: Delay in milliseconds between processing each *row* of the CSV file (default: 0). Note: This delay applies *after* all requests for a row are completed.
- `--interactive` or `-i`: Run in interactive mode, prompting for confirmation (y/n) after processing each row.
- `--generate-config`: Generate a basic configuration file based on the headers of the specified `--csv` file and exit. Use `--output-config` to specify the output filename (defaults to `mapping/<csv-basename>-config.json`).
- `--output-config`: Specify the path for the generated config file when using `--generate-config`.
- `--help` or `-h`: Show help information.

### Example

```bash
node index.js --csv source/sample-data.csv --config mapping/sample-multi-request-config.json --apikey YOUR_API_KEY --delay 500
```

## Configuration File

The configuration file (`--config`) is a JSON file that defines how to process each row of the CSV. It supports two main formats: Single Request and Multi-Request Sequence.

### Single Request Format (Legacy)

For simple cases where only one API call is needed per CSV row, the configuration file has the following top-level structure:

```json
{
  "endpoint": "YOUR_API_ENDPOINT_URL_TEMPLATE",
  "method": "POST", // Optional: Defaults to POST. Supports GET, PUT, PATCH, DELETE.
  "payloadTemplate": {
    "field1": "$csvColumn1",
    "nested": {
      "field2": "$csvColumn2"
    }
    // ... structure matching your API request body ...
  }
}
```

- `endpoint`: The target API URL. Can include placeholders like `$csvColumnName` which will be replaced by CSV data (URL-encoded).
- `method`: The HTTP method (e.g., "POST", "PUT", "GET").
- `payloadTemplate`: The JSON structure for the request body. Use `$csvColumnName` placeholders for CSV data.

### Multi-Request Sequence Format

To perform multiple API calls sequentially for each CSV row (e.g., create a record, then update it using the ID from the first response), use the `requests` array format:

```json
{
  "requests": [
    {
      "name": "Request 1: Create Resource", // Optional name for logging
      "endpoint": "https://api.example.com/v1/resources",
      "method": "POST",
      "payloadTemplate": {
        "name": "$csvNameField",
        "type": "$csvTypeField"
      },
      "extractFromResponse": {
        "field": "resourceId",      // Name for the placeholder (e.g., $resourceId)
        "jsonPath": "id"            // Path to value in response JSON (e.g., response.id)
        // Use dot notation for nested paths, e.g., "data.attributes.uuid"
      }
    },
    {
      "name": "Request 2: Update Resource", // Optional name
      "endpoint": "https://api.example.com/v1/resources/$resourceId", // Uses extracted ID
      "method": "PUT",
      "payloadTemplate": {
        "status": "processed",
        "processedBy": "script",
        "originalId": "$resourceId" // Can use extracted value in payload too
      }
    }
    // Add more request objects here for longer sequences
  ]
}
```

- `requests`: An array where each object defines one request in the sequence.
- **Each Request Object:**
    - `name` (Optional): Descriptive name for logging.
    - `endpoint`: URL template for this specific request. Can use `$csvColumn` and `$extractedField` placeholders.
    - `method`: HTTP method for this request.
    - `payloadTemplate`: Body template for this request. Can use `$csvColumn` and `$extractedField` placeholders.
    - `extractFromResponse` (Optional): Defines how to extract data from *this* request's response to be used in *subsequent* requests within the *same row's sequence*.
        - `field`: The name of the placeholder for the extracted value (e.g., `resourceId` becomes `$resourceId`).
        - `jsonPath`: A simple dot-notation path to the desired value within the response JSON (e.g., `id`, `data.id`, `attributes.nested.value`).

**Placeholder Resolution:** When replacing placeholders (`$placeholderName`) in `endpoint` or `payloadTemplate`:
1.  The script first checks if `placeholderName` exists in the data extracted from *previous* requests in the current row's sequence.
2.  If not found there, it checks if `placeholderName` exists as a column header in the CSV row data.
3.  If found in neither, the placeholder remains unchanged (a warning may be logged).

## CSV File Format

The CSV file should contain columns that match the placeholders used in the configuration template(s). The column headers in the CSV file should match the placeholder names without the `$` prefix (e.g., a `$customerId` placeholder expects a `customerId` column in the CSV).

Example CSV file:

```csv
customerId,customerName,email,productId,quantity,price,totalAmount
1001,John Doe,john@example.com,PRD-123,2,29.99,59.98
1002,Jane Smith,jane@example.com,PRD-456,1,49.99,49.99
```

## Data Type Conversion

The script automatically converts values from the CSV to appropriate data types:
- Empty strings or "null" are converted to `null`
- "true" and "false" are converted to boolean values
- Numeric strings are converted to numbers
- Other values remain as strings

## Error Handling

The script provides detailed error information for failed requests during processing, including:
- Which row number failed.
- Which request step (if using multi-request) failed.
- HTTP status codes (if the error was an API response).
- API response data (if available).
- Other error messages (e.g., network errors, config errors).
Processing continues to the next row by default even if an error occurs on the current row.

## License

ISC