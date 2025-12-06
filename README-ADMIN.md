# Admin Interface

A web-based interface for managing stock mappings and viewing application logs.

## Features

- **Stock Mapping Management**: Add, view, and delete stock key-value pairs
- **Log Viewer**: View real-time application logs with auto-refresh
- **Simple UI**: Clean, modern interface accessible via web browser

## Access

Once the Docker containers are running, access the admin interface at:

```
http://localhost:3001
```

## Usage

### Stock Mapping Tab

1. Enter a stock key (the value from the email's STOCK field)
2. Enter the corresponding stock code (the value to use in PrintIQ)
3. Click "Add Mapping" to save
4. View all mappings in the table below
5. Click "Delete" to remove any mapping

### Logs Tab

1. View the latest log entries from the application
2. Adjust the number of lines to display (10-1000)
3. Logs auto-refresh every 5 seconds
4. Log entries are color-coded by level:
   - **ERROR**: Red
   - **WARN**: Yellow
   - **INFO**: Cyan

## Docker Compose

The admin interface is automatically included in `docker-compose.yml` and runs on port 3001.

To start all services:

```bash
docker-compose up -d
```

To view logs:

```bash
docker-compose logs -f admin
```

## API Endpoints

- `GET /api/stock-mapping` - Get all stock mappings
- `PUT /api/stock-mapping/:key` - Add/update a stock mapping
- `DELETE /api/stock-mapping/:key` - Delete a stock mapping
- `GET /api/logs/latest/:lines?` - Get latest log entries (default: 100 lines)
