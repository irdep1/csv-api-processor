# CSV API Processor

A powerful tool for processing CSV data through API endpoints with support for conditional requests, data extraction, and looping over secondary CSV files.

## Features

- Process CSV data through API endpoints
- Support for multiple sequential requests per row
- Conditional request execution based on data values
- Extract data from responses for use in subsequent requests
- Loop over secondary CSV files for nested data processing
- Interactive mode for manual approval of each request
- Comprehensive error logging
- Configurable delays between requests

## Installation

```bash
npm install
```

## Usage

### Basic Usage

```bash
node index.js --csv <csv-file> --config <config-file> --apikey <api-key>
```

### Advanced Usage

```bash
node index.js --csv <csv-file> --loop-csv <secondary-csv> --config <config-file> --apikey <api-key> [--interactive] [--delay <ms>]
```

### Command Line Arguments

- `--csv, -c`: Path to the primary CSV file (required)
- `--loop-csv, -l`: Path to the secondary CSV file for looping (optional)
- `--config, -f`: Path to the JSON configuration file (required)
- `--apikey, -k`: API key for authentication (required)
- `--interactive`: Run in interactive mode, prompting for each request (optional)
- `--delay, -d`: Delay between requests in milliseconds (optional, default: 0)
- `--generate-config`: Generate a basic config file from CSV headers
- `--output-config`: Specify output file for generated config

## Configuration

The configuration file defines the sequence of API requests to be made for each row in the CSV file. Here's an example:

```json
{
  "requests": [
    {
      "name": "Create Account",
      "endpoint": "https://api.example.com/accounts",
      "method": "POST",
      "payloadTemplate": {
        "name": "$accountName",
        "description": "$description"
      },
      "extractFromResponse": {
        "field": "accountId",
        "jsonPath": "id"
      }
    },
    {
      "name": "Create Product",
      "endpoint": "https://api.example.com/products",
      "method": "POST",
      "condition": {
        "type": "comparison",
        "left": "$price",
        "operator": ">",
        "right": 20
      },
      "payloadTemplate": {
        "name": "$productType",
        "price": "$price",
        "accountId": "$accountId"
      },
      "extractFromResponse": [
        {
          "field": "productId",
          "jsonPath": "id"
        },
        {
          "field": "totalAmount",
          "jsonPath": "total"
        }
      ]
    },
    {
      "name": "Create Contacts",
      "endpoint": "https://api.example.com/contacts",
      "method": "POST",
      "loopOver": "loop-cases.csv",
      "condition": {
        "type": "comparison",
        "left": "$approvalLevel",
        "operator": ">=",
        "right": 2
      },
      "payloadTemplate": {
        "name": "$contactName",
        "email": "$contactEmail",
        "role": "$contactRole",
        "accountId": "$accountId"
      }
    }
  ]
}
```

### Configuration Options

- `name`: Descriptive name for the request
- `endpoint`: API endpoint URL
- `method`: HTTP method (GET, POST, PUT, DELETE)
- `payloadTemplate`: Template for request payload with placeholders
- `condition`: Optional condition for request execution
- `extractFromResponse`: Fields to extract from response
- `loopOver`: Secondary CSV file to loop over

### Placeholders

- Use `$columnName` to reference CSV columns
- Use `$extractedField` to reference data extracted from previous responses

### Conditions

Conditions support comparison operators:
- `>`: Greater than
- `>=`: Greater than or equal
- `<`: Less than
- `<=`: Less than or equal
- `==`: Equal to
- `===`: Strictly equal to
- `!=`: Not equal to
- `!==`: Strictly not equal to

## Sample Files

### sample-cases.csv
```csv
accountName,description,price,quantity,discountThreshold,region,productType,subscriptionType,contractLength,autoRenew
Acme Corp,Enterprise customer,1000,5,500,US,Enterprise,Annual,12,true
Beta Inc,Startup customer,50,1,100,EU,Basic,Monthly,1,true
```

### loop-cases.csv
```csv
contactName,contactEmail,contactRole,department,approvalLevel
John Doe,john@example.com,Admin,IT,3
Jane Smith,jane@example.com,Manager,Finance,2
```

## Error Handling

Errors are logged to `error_log.csv` with the following information:
- Timestamp
- Row number
- Request name
- Status code
- Error message

## License

MIT