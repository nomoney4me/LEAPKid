require('dotenv').config()

var 	memoize = require('memoizee'),
	Promise = require('bluebird'),
	bodyParser = require('body-parser'),
	moment = require('moment'),
	bhttp = require('bhttp')

var CronJob = require('cron').CronJob;
new CronJob({
	cronTime: '00 00 10 * * 0-6',
	timeZone:'America/Los_Angeles',
	onTick: function() {
		Promise.try(() => {
				updateDB_students()
			}).then(() => {
				setTimeout(function() {
					updateDB_staff()
				}, 2000)
			})
		console.log('updating db: happening every day at 10:00am')	
	}
}).start();

var knex = require('knex')({
	client:'pg',
	connection: {
		host:process.env.DB_HOST,
		user:process.env.DB_USER,
		password:process.env.DB_PASS,
		database:process.env.DB_NAME,
	}
	//,debug:true
});

var express = require('express');
var app = express();

var http = require('http');
var server = http.createServer(app)
var	io = require('socket.io').listen(server);

// ----------------- https server ---------
app.use(express.static(__dirname+'/public'));
app.use(bodyParser.urlencoded({ extended: false }))


// ---------------------------custom function -----------------------

	/*
	-----------------------------------------
	displayList()
	-----------------------------------------
	*/
	function displayList(gradelevel) {
		var now = moment().startOf('day').format('YYYY-MM-DD HH:mm:ss');	
		var query = 'select st."UserID", st."FirstName", st."LastName", st."Activity_ID", st."Activity_Name", att."checkedin_time", att."checkedout_time" '+
									'from '+
									'(select * from onproducts."students" cross join leapkid."Activity") as st '+
									'left join leapkid."Attendance" as att '+
									'on st."UserID" = att."UserID" and st."Activity_ID" = att."Activity_ID" and att."checkedin_time" > \''+now+'\' '+
									'where st."Current_Student" is true '+
									'and st."GradeLevel" = \''+gradelevel+'\' '+
								'order by st."LastName" asc, st."FirstName" asc, st."Activity_ID" asc '
		var studentList = knex.raw(query).then((result) => {
			return result.rows
		})

		studentList.then((list) => {
			// combine the rows into one json object
			var newList = list.reduce((result, obj) => {
			  if(result[obj.UserID]) { 		//copy the current activites before adding a new one
			    var activities = result[obj.UserID].Activities
			    activities[obj.Activity_ID] = {
			      Activity_ID:obj.Activity_ID,
			      Activity_Name:obj.Activity_Name,
			      checkedin_time:obj.checkedin_time,
			      checkedout_time:obj.checkedout_time
			    }
			  }else {		//if no current, make a new Activities object
			    var activities = {};
			    activities[obj.Activity_ID] = {
			      Activity_ID:obj.Activity_ID,
			      Activity_Name:obj.Activity_Name,
			      checkedin_time:obj.checkedin_time,
			      checkedout_time:obj.checkedout_time
			    }
			  }
			  var tmp = {
			    FirstName:obj.FirstName,
			    LastName:obj.LastName,
			    UserID:obj.UserID,
			    Activities: activities
			  }
			  return Object.assign({}, result, {[obj.UserID]:tmp})
			}, [])
			//console.log(newList)
			io.to(gradelevel).emit('students result list', newList)
		})
	} //end displayList()






/*
	-----------------------------------------
	get up-to-date list from onProducts and insert into postgresql
	-----------------------------------------
*/
	function getToken() {
		return bhttp.get(process.env.API_LINK+'/api/authentication/login/?username='+process.env.onAPI_USER+'&password='+process.env.onAPI_PASS+'&format=json')
				.then((resp) => {
					return resp.body
				})
	}


/*
	-----------------------------------------
	set false to all Current_Student before matching 
	-----------------------------------------
*/

	let resetAll = knex('students').withSchema('onproducts').update({
		Current_Student:'False'
	})

/*
	-----------------------------------------
	mysqlCheckin 
	-----------------------------------------
*/
	let MysqlCheckin = function MysqlCheckin(record) {
		var selectedGradeLevel = record.selectedGradeLevel
		
		let insert_query = knex('leapkid.Attendance').insert({
			Activity_ID:record.Activity_ID,
			UserID:record.UserID,
			checkedin_time:record.now
		}).toString();
		
		knex.raw(insert_query).then((result) => {
			console.log(result)
		}).then((record) => {
			console.log("updating dashboard: "+selectedGradeLevel)
			displayList(selectedGradeLevel)
		})
	} // end MysqlCheckin

/*
	-----------------------------------------
	delete the checkedin_time from the db
	-----------------------------------------
*/
	let undoMysqlCheckin = function undoMysqlCheckin(record) {
		var selectedGradeLevel = record.selectedGradeLevel
		knex.transaction((trx) => {
			knex('leapkid.Attendance').select('*')
				.where('checkedin_time', '>', record.now)
				.where('checkedin_time', '<', record.tomorrow)
				.where('UserID', '=', record.UserID)
				.where('Activity_ID', '=', record.Activity_ID)
				.whereNull('checkedout_time')
			.del().then(trx.commit).catch(trx.rollback)
		}).then(() => {
			console.log("updating dashboard: "+selectedGradeLevel)
			displayList(selectedGradeLevel)
		})
	}

/*
	-----------------------------------------
	update students
	onProducts info:
		Created by:		Tien Bui
		Name:					All Current Students
		listID: 			55606
	-----------------------------------------
*/
	let updateDB_students = function() {
		// update students
		Promise.try(() => {
			return knex('students').withSchema('onproducts').where('UserID', '>', '0').update({
				Current_Student:'False'
			})
		}).then(() => {
			getToken().then((cred) => {
				// onProducts | listID: 55606 | Name: All Current Students
				return Promise.try(() => {
					return bhttp.get(process.env.API_LINK+'/api/list/55606/?t='+cred.Token+'listID=55606').then((data) => {
						return data.body
					})
				}).map((item) => {
					if(item.GradeLevelAbbreviation === "Pre-K") {
						item.GradeLevelAbbreviation = "SK"
					}
					
					if(item.GradeLevelAbbreviation === "K") {
						item.GradeLevelAbbreviation = "JK"
					}
					
					let query = knex('onproducts.students').insert({
							UserID:item.UserID,
							FirstName:item.FirstName,
							LastName:item.LastName,
							GradeLevel:item.GradeLevelAbbreviation,
							Current_Student:true
					}).toString();
					
					query += ' ON CONFLICT ("UserID") DO UPDATE SET '+
										' "Current_Student" = \'True\', "GradeLevel" = \''+item.GradeLevelAbbreviation+'\''
					return knex.raw(query)
				}, {concurrency:1000}).then(() => {
					console.log('student update completed')
				})
			})
		})
	}
/*
	-----------------------------------------
	update leap staff in postgresql
	Student list in onProducts:
		Created by: 	Tien Bui
		Name: 				LEAP Staff
		listID: 			59430
	-----------------------------------------
*/
	let updateDB_staff = function() {
	//update leapstaff
		getToken().then((cred) => {
			// onProducts | listID: 59430 | Name: LEAP Staff
			return bhttp.get(process.env.API_LINK+'/api/list/59430/?t='+cred.Token+'listID=59430').then((result) => {
				return result.body
			})
		}).map((staff) => {
			var pin = staff.PhoneNumber.slice(-4)
			
			let query = knex('onproducts.leapstaff').insert({
					UserID:staff.UserID,
					FirstName:staff.FirstName,
					LastName:staff.LastName,
					Pin:pin
			}).toString();
			
			query += ' ON CONFLICT ("UserID") DO UPDATE SET '+
								' "Pin" = \''+pin+'\''
			
			return knex.raw(query)
		}, {concurrency:25}).then(() => {
			console.log('staff update complete')
		})
	}


/*
	-----------------------------------------
	Undo admin check-out function
	-----------------------------------------
*/
	let undoAdminCheckout = function undoAdminCheckout(record) {
		record.start = moment().startOf('day').format('YYYY-MM-DD HH:mm:ss')
		record.end = moment().endOf('day').format('YYYY-MM-DD HH:mm:ss')
		Promise.try(() => {
			var undoQuery = 'update leapkid."Attendance" '+
												'set "checkedout_time" = NULL '+
											'where "UserID" = '+record.UserID+' '+
											'and checkedin_time between \''+record.start+'\' and \''+record.end+'\' '+
											'and checkedout_time is not NULL'
			
			return knex.raw(undoQuery).then((rows) => {
				return rows
			})
		}).then((result) => {
			console.log("updating dashboard: "+record.selectedGradeLevel)
			displayList(record.selectedGradeLevel)
		})
	}

/*
	-----------------------------------------
	io socket starts here
	-----------------------------------------
*/
io.on('connection', (socket) => {
	// keep postgresql DB up-to-date
	socket.on('update db', () => {
		Promise.try(() => {
			updateDB_students()
		}).then(() => {
			setTimeout(function() {
				updateDB_staff()
			}, 2000)
			
		})
	})
	
	// each time a user changes "gradelevel"
	socket.on('request to join room', (gradelevel) => {
		socket.join(gradelevel)
		for(var room in socket.rooms) {
			if(room != gradelevel) {
				socket.leave(room)	
			}
		}		
	})

	// listen for request to display student
	socket.on('request records from DB', (gradelevel) => {
		displayList(gradelevel)
	})

	// listen for check in request
	socket.on('insertmysql request', (record) => {
		record.now = moment().format('YYYY-MM-DD HH:mm:ss');
		record.tomorrow = moment().startOf('day').add(1, 'day').format('YYYY-MM-DD HH:mm:ss');
		MysqlCheckin(record)
	})


	socket.on('undo checkin request', (record) => {
		record.now = moment().startOf('day').format('YYYY-MM-DD HH:mm:ss');
		record.tomorrow = moment().startOf('day').add(1, 'day').format('YYYY-MM-DD HH:mm:ss');
		undoMysqlCheckin(record)
	})

/*
	-----------------------------------------
	start building parent stuffs includes:
		'parentlogin request'
		'checkout student request'
	-----------------------------------------
*/
	//parent login function
	socket.on('parentlogin request', (obj) => {
		socket.join(obj.user)
		Promise.try(() => {
			return bhttp.get(process.env.API_LINK+'/api/authentication/login/?username='+obj.user+'&password='+obj.pass+'&format=json').then((result) => {
				return result.body
			})
		}).then((parent) => {
			if(parent.Token) {
				return bhttp.get(process.env.API_LINK+'/api/datadirect/UserRelationshipGet/?t='+parent.Token+'&userId='+parent.UserId).then((result) => {
					return result.body
				})
			}else {
				return 'Invalid username/password';
			}
		}).then((data) => {
			io.in(obj.user).emit('mychildren result', data);
		})
	})

	//parent checkout function
	socket.on('checkout student request', (student) => {
		//console.log(socket.rooms)
		Promise.try(() => {
			//add checkedout_time to the student
			var today = moment().format('YYYY-MM-DD 00:00:00');
			var rightNow = moment().format('YYYY-MM-DD HH:mm:ss');
			return knex('leapkid.Attendance')
							.where('UserID', '=', student.UserId)
							.andWhere('checkedin_time', '>', today)
						.update({
							checkedout_time:rightNow
							//checkedout_by:student.checkedout_by
						})
		}).then(() => {
			//pull all the available grade level to update the dashboard view
			let listGradeLevels = 'select t1."GradeLevel" from onproducts."students" as t1 '+
											'left join onproducts."students" as t2 '+
											'on t1."GradeLevel" = t2."GradeLevel" and '+
													't1."UserID" < t2."UserID" '+
											'where t2."GradeLevel" is null and t1."GradeLevel" is not null'
			
			return knex.raw(listGradeLevels).then((results) => {
				return results.rows
			})
		}).map((grade) => {
			console.log(grade.GradeLevel)
			displayList(grade.GradeLevel)
		})
	})
// --------------------end parent login---------------------------



// --------------------start staff login---------------------------

	socket.on('login request', (pin) => {
		Promise.try(() => {
			return knex('onproducts.leapstaff').where('Pin', pin)
		}).then((rows) => {
			socket.emit('login result', rows)
		})
	})
// --------------------end staff login---------------------------

	socket.on('admin checkout', (obj) => {
		var today = moment().format('YYYY-MM-DD')
		
		obj.checkedout_time = today+" "+obj.checkedout_time
		
		return knex('leapkid.Attendance').where('checkedin_time', '>', today+" 00:00:00")
																			.andWhere('UserID', '=', obj.UserID)
																			.update({
																				'checkedout_time':obj.checkedout_time
																			})
					.then((rows) => {
							return rows
		}).then((rows) => {
			displayList(obj.selectedGradeLevel)
		})
	})
	
	
	socket.on('undo checkout request', (obj) => {
		undoAdminCheckout(obj)
	})
	

	
}) // end of io stuffs

// running on port:
server.listen(3000)
