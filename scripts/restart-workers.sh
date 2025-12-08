#!/bin/bash
pm2 restart machinist-worker
pm2 restart archivist-worker
pm2 restart endpoints-server
pm2 status
