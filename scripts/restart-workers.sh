#!/bin/bash
pm2 restart machinist-worker
pm2 restart archivist-worker
pm2 restart health-server
pm2 status
