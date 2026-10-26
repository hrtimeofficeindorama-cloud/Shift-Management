function syncEmployeeRecords() {
  const FOLDER_ID = "1DZ2MYPvTR1HMSVUIE3fcCIBVLyrBqxD1";
  const SPREADSHEET_ID = "1Mzh0H6PQTq6w47fIlMJ6qUL9UT3NvpBvuoBRN_DrSA8";
  const SHEET_NAME = "Emp_List";

  // Core mapped headers
  const coreHeaders = [
    "Emp ID",
    "Emp Name",
    "Category",
    "Class",
    "Phone Number",
    "Official Email",
    "Personal Email",
    "Business Unit",
    "Function",
    "Department"
  ];

  // Files processing order
  const fileNames = [
    "Employee List for Leave.csv",
    "Employee_National_Master.csv",
    "Employee_Expat_Master.csv"
  ];

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(SHEET_NAME);
  
  // 1. Capture existing sheet data (preserves SIC, Manager, Role, Password, Secret Question, etc.)
  const existingDataMap = {};
  let existingExtraHeaders = [];

  if (sheet && sheet.getLastRow() > 1) {
    const existingRange = sheet.getDataRange().getValues();
    const existingHeaders = existingRange[0].map(h => h.toString().trim());
    
    // Identify any columns beyond our core mapped headers
    existingExtraHeaders = existingHeaders.filter(h => !coreHeaders.includes(h));
    
    const empIdColIdx = existingHeaders.indexOf("Emp ID");
    if (empIdColIdx !== -1) {
      for (let i = 1; i < existingRange.length; i++) {
        const row = existingRange[i];
        const empId = row[empIdColIdx] ? row[empIdColIdx].toString().trim() : "";
        if (empId) {
          const rowData = {};
          existingHeaders.forEach((header, idx) => {
            rowData[header] = row[idx];
          });
          existingDataMap[empId] = rowData;
        }
      }
    }
  }

  // 2. Fetch and parse CSV files from Drive folder
  const folder = DriveApp.getFolderById(FOLDER_ID);
  const seenEmpIds = new Set();
  const outputRows = [];

  fileNames.forEach(fileName => {
    const files = folder.getFilesByName(fileName);
    if (!files.hasNext()) {
      Logger.log("File not found: " + fileName);
      return;
    }

    const file = files.next();
    const csvContent = file.getBlob().getDataAsString();
    const csvData = Utilities.parseCsv(csvContent);

    if (csvData.length < 2) return;

    const headerRow = csvData[0].map(h => h.toString().trim());
    
    // Helper to find column index supporting both normal names and "Emp List[...]" wrappers
    const getColIdx = (possibleNames) => {
      if (!Array.isArray(possibleNames)) possibleNames = [possibleNames];
      for (let name of possibleNames) {
        let idx = headerRow.findIndex(h => h.toLowerCase() === name.toLowerCase());
        if (idx !== -1) return idx;
        idx = headerRow.findIndex(h => h.toLowerCase() === `emp list[${name.toLowerCase()}]`);
        if (idx !== -1) return idx;
      }
      return -1;
    };

    for (let i = 1; i < csvData.length; i++) {
      const row = csvData[i];
      let empId = "", empName = "", category = "", classVal = "";
      let phoneNumber = "", officialEmail = "", personalEmail = "";
      let businessUnit = "", functionVal = "", department = "";

      if (fileName === "Employee List for Leave.csv") {
        empId = getValue(row, getColIdx(["Emp ID"]));
        empName = getValue(row, getColIdx(["Emp Name"]));
        category = "Trainee";
        classVal = "National";
        phoneNumber = "";
        officialEmail = getValue(row, getColIdx(["Phone Number"]));
        personalEmail = getValue(row, getColIdx(["Email"]));
        businessUnit = getValue(row, getColIdx(["Business Unit"]));
        functionVal = "";
        department = getValue(row, getColIdx(["Department"]));

      } else {
        empId = getValue(row, getColIdx(["Emp ID"]));
        empName = getValue(row, getColIdx(["Full Name"]));
        category = getValue(row, getColIdx(["Designation"]));
        classVal = fileName === "Employee_National_Master.csv" ? "National" : "Expat";
        phoneNumber = getValue(row, getColIdx(["Personal Mobile Number"]));
        officialEmail = getValue(row, getColIdx(["Official Email Id"]));
        personalEmail = getValue(row, getColIdx(["Personal Email Id"]));
        businessUnit = getValue(row, getColIdx(["Group Company Code"]));
        functionVal = getValue(row, getColIdx(["Departments Hierarchy_1_Name"]));
        department = getValue(row, getColIdx(["Departments Hierarchy_2_Name"]));

      }

      if (!empId) continue;

      // Apply Business Unit transformations
      if (businessUnit === "IFL") {
        businessUnit = "IFZ";
      } else if (businessUnit === "OIP") {
        businessUnit = "OIS";
      }

      // Deduplication check: Retain first occurrence, discard duplicates
      if (!seenEmpIds.has(empId)) {
        seenEmpIds.add(empId);
        
        // Build base record object
        const rowObj = {
          "Emp ID": empId,
          "Emp Name": empName,
          "Category": category,
          "Class": classVal,
          "Phone Number": phoneNumber,
          "Official Email": officialEmail,
          "Personal Email": personalEmail,
          "Business Unit": businessUnit,
          "Function": functionVal,
          "Department": department

        };

        // Attach existing extra columns (SIC, Manager, Role, Password, secret question, etc.) if matched by Emp ID
        if (existingDataMap[empId]) {
          existingExtraHeaders.forEach(eh => {
            rowObj[eh] = existingDataMap[empId][eh] !== undefined ? existingDataMap[empId][eh] : "";
          });
        } else {
          existingExtraHeaders.forEach(eh => {
            rowObj[eh] = "";
          });
        }

        outputRows.push(rowObj);
      }
    }
  });

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }

  // 3. Combine core headers and preserved extra columns
  const finalHeaders = [...coreHeaders, ...existingExtraHeaders];
  const finalDataMatrix = [finalHeaders];

  outputRows.forEach(rowObj => {
    const rowArray = finalHeaders.map(h => rowObj[h] !== undefined ? rowObj[h] : "");
    finalDataMatrix.push(rowArray);
  });

  // 4. Clear and perform single batch write
  sheet.clearContents();
  if (finalDataMatrix.length > 0) {
    sheet.getRange(1, 1, finalDataMatrix.length, finalHeaders.length).setValues(finalDataMatrix);
  }
}

function getValue(row, index) {
  if (index === -1 || index >= row.length) return "";
  return row[index] ? row[index].toString().trim() : "";
}
