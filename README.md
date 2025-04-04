# CSV API Processor

A Node.js utility for processing CSV data and sending it to an API endpoint using a configurable template.

## Description

This tool reads data from a CSV file, applies it to a JSON template defined in a configuration file, and sends the resulting payloads to a specified API endpoint. It's useful for data migration, API integration, and batch processing tasks.

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
node index.js --csv <path-to-csv> --config <path-to-config> --apikey <your-api-key> --endpoint <api-endpoint> [--delay <ms>]
```

### Required Arguments

- `--csv` or `-c`: Path to the CSV file containing the data to process
- `--config` or `-f`: Path to the configuration file with the payload template
- `--apikey` or `-k`: API key for authentication
- `--endpoint` or `-e`: API endpoint URL

### Optional Arguments

- `--delay` or `-d`: Delay between requests in milliseconds (default: 0)
- `--help` or `-h`: Show help information

### Example

```bash
node index.js --csv data.csv --config config.json --apikey testkey --endpoint https://webhook.site/948eecfe-2351-447e-98c6-1f34c2e4fb7a --delay 1000
```

## Configuration File

The configuration file should be a JSON file containing a `payloadTemplate` object. This template defines the structure of the data to be sent to the API. Placeholders in the template are prefixed with `$` and will be replaced with corresponding values from the CSV file.

Example configuration file:

```json
{
  "payloadTemplate": {
    "customer": {
      "id": "$customerId",
      "name": "$customerName",
      "email": "$email"
    },
    "order": {
      "products": [
        {
          "id": "$productId",
          "quantity": "$quantity",
          "price": "$price"
        }
      ],
      "totalAmount": "$totalAmount"
    }
  }
}
```

## CSV File Format

The CSV file should contain columns that match the placeholders in the configuration template. The column headers in the CSV file should match the placeholder names without the `$` prefix.

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

The script provides detailed error information for failed requests, including:
- HTTP status codes
- Response data from the API
- Error messages

## License

ISC